use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::Arc;

use tokio_util::sync::CancellationToken;

use super::SessionWorkspaceValidation;
use super::path::{canonical_path, listed_worktree_matches, precheck_linked_worktree};
use crate::workspace::WorkspaceCode;
use crate::workspace::{
    CommandStep, Commands, StructuredCommandInput, StructuredCommandOutput, WorkspaceError,
    WorkspaceFiles, WorkspaceResult,
};

/// A project workspace: a folder, a git checkout, or unavailable.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum ProjectWorkspaceInspection {
    Folder,
    Git { branch: Option<String>, dirty: bool },
    Unavailable { code: &'static str },
}

/// Runs git commands for one inspection or validation under a shared abort.
struct GitProbe<'a> {
    commands: &'a Commands,
    host_environment: &'a Arc<HashMap<String, String>>,
    abort: CancellationToken,
}

impl GitProbe<'_> {
    async fn run(&self, cwd: &str, args: &[&str]) -> WorkspaceResult<StructuredCommandOutput> {
        git(
            self.commands,
            self.host_environment,
            cwd,
            args,
            self.abort.clone(),
        )
        .await
    }
}

/// Classifies a project workspace as a plain folder, a git checkout (with
/// its current branch and dirtiness) or unavailable.
pub(super) async fn inspect_project_workspace(
    commands: &Commands,
    files: &WorkspaceFiles,
    host_environment: &Arc<HashMap<String, String>>,
    workspace_path: &str,
    abort: CancellationToken,
) -> WorkspaceResult<ProjectWorkspaceInspection> {
    let unavailable = |code| ProjectWorkspaceInspection::Unavailable { code };
    let path = workspace_path.to_owned();
    let exists = files
        .run(move || {
            std::fs::symlink_metadata(path)
                .map(|metadata| metadata.is_dir())
                .unwrap_or(false)
        })
        .await
        .map_err(WorkspaceError::from)?;
    if !exists {
        return Ok(unavailable("git_workspace_unavailable"));
    }
    let probe = GitProbe {
        commands,
        host_environment,
        abort,
    };
    let version = probe.run(workspace_path, &["--version"]).await?;
    if let Some(code) = command_failure_code(&version, WorkspaceCode::GitWorkspaceUnavailable) {
        return Ok(unavailable(code.as_str()));
    }
    let inside = probe
        .run(workspace_path, &["rev-parse", "--is-inside-work-tree"])
        .await?;
    if inside.error.is_none()
        && (inside.exit_code != Some(0)
            || butler_core::public_text::trim_js_whitespace(&inside.stdout) != "true")
    {
        return Ok(ProjectWorkspaceInspection::Folder);
    }
    if let Some(code) = command_failure_code(&inside, WorkspaceCode::GitWorkspaceUnavailable) {
        return Ok(unavailable(code.as_str()));
    }
    let branch = probe
        .run(workspace_path, &["branch", "--show-current"])
        .await?;
    if command_failure(&branch, WorkspaceCode::GitWorkspaceUnavailable).is_some() {
        return Ok(unavailable("git_workspace_unavailable"));
    }
    let status = probe.run(workspace_path, &STATUS_ARGS).await?;
    if command_failure(&status, WorkspaceCode::GitWorkspaceUnavailable).is_some() {
        return Ok(unavailable("git_workspace_unavailable"));
    }
    let branch = public_branch_name(&branch.stdout);
    Ok(ProjectWorkspaceInspection::Git {
        branch: (!branch.is_empty()).then_some(branch),
        dirty: !status.stdout.is_empty(),
    })
}

const STATUS_ARGS: [&str; 4] = ["status", "--porcelain=v1", "-z", "--untracked-files=all"];

/// The trimmed branch name without control characters, at most 80 characters.
fn public_branch_name(stdout: &str) -> String {
    butler_core::public_text::trim_js_whitespace(stdout)
        .chars()
        .filter(|character| {
            let code = *character as u32;
            code > 31 && code != 127
        })
        .take(80)
        .collect()
}

/// Validates that `target` is a linked worktree of `anchor` with `branch`
/// checked out, and reports its canonical path and dirtiness.
pub(super) async fn validate_linked_worktree(
    commands: &Commands,
    files: &WorkspaceFiles,
    host_environment: &Arc<HashMap<String, String>>,
    anchor: &str,
    target: &str,
    branch: &str,
    abort: CancellationToken,
) -> WorkspaceResult<SessionWorkspaceValidation> {
    if abort.is_cancelled() {
        return Ok(invalid("cancelled"));
    }
    let target_for_check = target.to_owned();
    let exists = files
        .run(move || precheck_linked_worktree(&target_for_check))
        .await
        .map_err(WorkspaceError::from)?;
    if !exists {
        return Ok(invalid("session_workspace_unavailable"));
    }
    let probe = GitProbe {
        commands,
        host_environment,
        abort,
    };
    let unavailable = WorkspaceCode::SessionWorkspaceUnavailable;
    let top = probe.run(target, &["rev-parse", "--show-toplevel"]).await?;
    if let Some(validation) = command_failure(&top, unavailable) {
        return Ok(validation);
    }
    let worktrees = probe
        .run(anchor, &["worktree", "list", "--porcelain", "-z"])
        .await?;
    if let Some(validation) = command_failure(&worktrees, unavailable) {
        return Ok(validation);
    }
    let (target_for_list, branch_for_list) = (target.to_owned(), branch.to_owned());
    let listed = files
        .run(move || listed_worktree_matches(&worktrees.stdout, &target_for_list, &branch_for_list))
        .await
        .map_err(WorkspaceError::from)?
        .map_err(io_error)?;
    if !listed {
        return Ok(invalid("session_workspace_unavailable"));
    }
    let symbolic = probe
        .run(target, &["symbolic-ref", "--quiet", "--short", "HEAD"])
        .await?;
    if let Some(validation) = command_failure(&symbolic, unavailable) {
        return Ok(validation);
    }
    if butler_core::public_text::trim_js_whitespace(&symbolic.stdout) != branch {
        return Ok(invalid("session_workspace_unavailable"));
    }
    let status = probe.run(target, &STATUS_ARGS).await?;
    if let Some(validation) = command_failure(&status, unavailable) {
        return Ok(validation);
    }
    let target_for_final = target.to_owned();
    let path = files
        .run(move || canonical_path(&target_for_final))
        .await
        .map_err(WorkspaceError::from)?
        .map_err(io_error)?;
    Ok(SessionWorkspaceValidation::Valid {
        path: path.to_string_lossy().into_owned(),
        dirty: !status.stdout.is_empty(),
    })
}

fn invalid(code: &'static str) -> SessionWorkspaceValidation {
    SessionWorkspaceValidation::Invalid { code }
}

fn command_failure(
    result: &StructuredCommandOutput,
    other_code: WorkspaceCode,
) -> Option<SessionWorkspaceValidation> {
    command_failure_code(result, other_code).map(|code| invalid(code.as_str()))
}

fn command_failure_code(
    result: &StructuredCommandOutput,
    other_code: WorkspaceCode,
) -> Option<WorkspaceCode> {
    if result.cancelled || result.timed_out {
        Some(WorkspaceCode::Cancelled)
    } else if result
        .error
        .as_ref()
        .is_some_and(|error| error.io_kind() == Some(std::io::ErrorKind::NotFound))
    {
        Some(WorkspaceCode::GitNotInstalled)
    } else if result.exit_code != Some(0) {
        Some(other_code)
    } else {
        None
    }
}

async fn git(
    commands: &Commands,
    host_environment: &Arc<HashMap<String, String>>,
    cwd: &str,
    args: &[&str],
    abort: CancellationToken,
) -> WorkspaceResult<StructuredCommandOutput> {
    let input = StructuredCommandInput {
        steps: vec![CommandStep {
            executable: "git".into(),
            arguments: args.iter().map(|argument| (*argument).into()).collect(),
        }],
        cwd: Some(PathBuf::from(cwd)),
        environment: HashMap::new(),
        host_environment: (**host_environment).clone(),
        inherit_environment: true,
        stdin: String::new(),
        timeout_ms: Some(30_000.0),
        abort,
        legacy: None,
    };
    commands
        .submit_structured(input)
        .map_err(WorkspaceError::from)?
        .await
        .map_err(|source| {
            WorkspaceError::new(
                WorkspaceCode::WorkspaceRecoveryCommandLost,
                "Git result lost",
            )
            .with_source(source)
        })
}

fn io_error(error: std::io::Error) -> WorkspaceError {
    WorkspaceError::new(WorkspaceCode::WorkspaceRecoveryIo, error.to_string()).with_source(error)
}
