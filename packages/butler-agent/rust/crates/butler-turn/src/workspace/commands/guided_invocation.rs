use std::collections::HashMap;
use std::path::{Path, PathBuf};

use butler_platform::command_sandbox::{self, ShellAccess};

use super::environment::Scratch;
use super::{CommandCode, CommandError, GuidedAccess, GuidedCommandInput};

/// A mutating command auto-allowed inside the project: it may write only the
/// project and its own scratch folders (temp, tool cache, generated
/// artifacts), never the rest of the Butler data folder.
fn project_write_shell(
    input: &GuidedCommandInput,
    environment: &HashMap<String, String>,
    secrets: &[PathBuf],
) -> Result<command_sandbox::Invocation, command_sandbox::SandboxError> {
    let data = &input.butler_data;
    let scratch = Scratch::new(data, true);
    let writable = [
        scratch.temporary.as_path(),
        scratch.cache.as_path(),
        scratch.artifacts.as_path(),
    ];
    // App project folders live under the data folder; the default deny already
    // covers it otherwise, so deny it explicitly only when it is not an ancestor.
    let mut denied: Vec<&Path> =
        if butler_platform::secure_fs::path_is_within(&input.workspace_root, data) {
            Vec::new()
        } else {
            vec![data.as_path()]
        };
    denied.extend(secrets.iter().map(PathBuf::as_path));
    command_sandbox::project_write_shell(
        &input.command,
        environment,
        &input.workspace_root,
        &writable,
        &denied,
    )
}

/// The login-shell invocation of a guided command. Read-only commands run in
/// the host sandbox; a host without one refuses them.
pub(super) fn invocation(
    input: &GuidedCommandInput,
    secrets: &[PathBuf],
) -> Result<command_sandbox::Invocation, CommandError> {
    let mut environment = input.host_environment.clone();
    environment.insert(
        "BUTLER_DATA".into(),
        input.butler_data.to_string_lossy().into_owned(),
    );
    let access = match input.access {
        GuidedAccess::FullAccessContained | GuidedAccess::ProjectWrite => ShellAccess::Full,
        GuidedAccess::ReadOnlyObservation | GuidedAccess::ContainedObservation => {
            ShellAccess::ReadOnly
        }
    };
    // Data-folder reads follow ordinary file access; only credential roots
    // and project secrets belong in the private-read exclusions.
    let shell = if input.access == GuidedAccess::ProjectWrite {
        project_write_shell(input, &environment, secrets)
    } else if input.access == GuidedAccess::ContainedObservation {
        command_sandbox::login_shell_contained(
            &input.command,
            &environment,
            &[],
            &[input.workspace_root.as_path()],
        )
    } else {
        command_sandbox::login_shell(&input.command, access, &environment)
    };
    let invocation = shell.map_err(|error| {
        CommandError::new(
            CommandCode::CommandObservationIsolationUnavailable,
            error.to_string(),
        )
    })?;
    Ok(invocation)
}
