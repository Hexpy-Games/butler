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
    cwd: &Path,
    environment: &HashMap<String, String>,
    secrets: &[PathBuf],
) -> Result<command_sandbox::Invocation, command_sandbox::SandboxError> {
    let data = &input.butler_data;
    let scratch = Scratch::new(data, true);
    let writable = scratch.writable_roots();
    // App project folders live under the data folder; the default deny already
    // covers it otherwise, so deny it explicitly only when it is not an ancestor.
    let mut denied: Vec<&Path> = if input.extra_write_roots.is_empty()
        && butler_platform::secure_fs::path_is_within(&input.workspace_root, data)
    {
        Vec::new()
    } else {
        vec![data.as_path()]
    };
    denied.extend(secrets.iter().map(PathBuf::as_path));
    if !input.extra_write_roots.is_empty() {
        denied.extend(input.installation_root.as_deref());
        denied.extend(input.protected_roots.iter().map(PathBuf::as_path));
    }
    let workspace = input.workspace_root.as_path();
    let mut extra: Vec<_> = input
        .extra_write_roots
        .iter()
        .map(PathBuf::as_path)
        .collect();
    let mut primary = workspace;
    if !extra.is_empty() {
        let include_workspace = !butler_platform::secure_fs::path_is_within(workspace, data);
        extra.extend(include_workspace.then_some(workspace));
        if let Some(index) = extra
            .iter()
            .position(|root| butler_platform::secure_fs::path_is_within(cwd, root))
        {
            primary = extra.remove(index);
        } else if !include_workspace {
            return Err(command_sandbox::SandboxError::ProjectWriteUnavailable);
        }
        extra.retain(|root| *root != primary);
        // Keep the folder-sandbox requirement when the primary is the sole grant.
        if extra.is_empty() {
            extra.push(primary);
        }
    }
    let toolchain_roots =
        butler_platform::account_dirs::account_dirs().map(|dirs| command_sandbox::ToolchainRoots {
            home: dirs.home,
            app_data: dirs.app_data,
            local_app_data: dirs.local_app_data,
        });
    command_sandbox::project_write_shell(
        &input.command,
        environment,
        primary,
        &extra,
        &writable,
        &denied,
        toolchain_roots.as_ref(),
    )
}

/// The login-shell invocation of a guided command. Read-only commands run in
/// the host sandbox; a host without one refuses them.
pub(super) fn invocation(
    input: &GuidedCommandInput,
    cwd: &Path,
    secrets: &[PathBuf],
) -> Result<command_sandbox::Invocation, CommandError> {
    let mut environment = input.host_environment.clone();
    environment.insert(
        "BUTLER_DATA".into(),
        input.butler_data.to_string_lossy().into_owned(),
    );
    environment.insert(
        "BUTLER_COMMAND_TIMEOUT_MS".into(),
        super::guided::guided_timeout(input.timeout_ms)
            .as_millis()
            .to_string(),
    );
    let access = match input.access {
        GuidedAccess::FullAccessContained
        | GuidedAccess::SecretReadsDenied
        | GuidedAccess::ProjectWrite => ShellAccess::Full,
        GuidedAccess::ReadOnlyObservation | GuidedAccess::ContainedObservation => {
            ShellAccess::ReadOnly
        }
    };
    // Data-folder reads follow ordinary file access; only credential roots
    // and project secrets belong in the private-read exclusions.
    let shell = if input.access == GuidedAccess::ProjectWrite {
        project_write_shell(input, cwd, &environment, secrets)
    } else if input.access == GuidedAccess::ContainedObservation {
        let roots: Vec<_> = std::iter::once(input.workspace_root.as_path())
            .chain(input.allowed_folders.iter().map(PathBuf::as_path))
            .collect();
        command_sandbox::login_shell_contained(&input.command, &environment, &[], &roots)
    } else if input.access == GuidedAccess::SecretReadsDenied {
        command_sandbox::login_shell(&input.command, access, &environment)
            .and_then(|shell| command_sandbox::deny_secret_reads(shell, &environment, None))
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

pub(super) async fn resolve_guided_cwd(
    input: &GuidedCommandInput,
    path_form: crate::workspace::PathForm,
) -> Result<PathBuf, CommandError> {
    use super::guided::guarded_directory;
    let root = input.workspace_root.clone();
    let cwd = input.cwd.clone();
    let data = input.butler_data.clone();
    let installation = input.installation_root.clone();
    let protected = input.protected_roots.clone();
    let allowed = input.allowed_folders.clone();
    tokio::task::spawn_blocking(move || {
        let Some(requested) = cwd.as_deref().filter(|value| !value.is_empty()) else {
            return Ok(root);
        };
        if path_form.contained() && !allowed.is_empty() {
            let absolute =
                butler_platform::tool_paths::resolve(&root, requested).map_err(CommandError::io)?;
            let roots = crate::workspace::ScopeRoots {
                project: Some(&root),
                allowed_folders: &allowed,
                butler_data: &data,
                protected_ledger_roots: &protected,
                installation_root: installation.as_deref(),
                attachments: &[],
            };
            if crate::workspace::classify_targets(&roots, &root, &[requested])
                == crate::workspace::TargetScope::AllowedFolder
            {
                let real = crate::workspace::path_guard::realpath_or_nearest(&absolute);
                if let Some(folder) = allowed.iter().find(|folder| {
                    butler_platform::secure_fs::path_is_within(&real, folder)
                        && butler_platform::secure_fs::canonicalize(folder)
                            .as_ref()
                            .is_ok_and(|path| path == *folder)
                }) {
                    return guarded_directory(folder, Some(&real.to_string_lossy()), path_form);
                }
            }
        }
        guarded_directory(&root, Some(requested), path_form)
    })
    .await
    .map_err(|error| {
        CommandError::new(CommandCode::CommandCwdFailed, error.to_string()).with_source(error)
    })?
}
