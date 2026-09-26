use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::Arc;

use tokio_util::sync::CancellationToken;

use super::SessionWorkspaceValidation;
use super::path::{canonical_path, listed_worktree_matches, precheck_linked_worktree};
use crate::workspace::WorkspaceCode;
use crate::workspace::{
    CommandStep, NativeCommands, NativeWorkspaceFiles, StructuredCommandInput,
    StructuredCommandOutput, WorkspaceError, WorkspaceResult,
};

#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) enum ProjectWorkspaceInspection {
    Folder,
    Git { branch: Option<String>, dirty: bool },
    Unavailable { code: &'static str },
}

pub(super) async fn inspect_project_workspace(
    commands: &NativeCommands,
    files: &NativeWorkspaceFiles,
    host_environment: &Arc<HashMap<String, String>>,
    workspace_path: &str,
    abort: CancellationToken,
) -> WorkspaceResult<ProjectWorkspaceInspection> {
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
        return Ok(ProjectWorkspaceInspection::Unavailable {
            code: "git_workspace_unavailable",
        });
    }
    let version = git(
        commands,
        host_environment,
        workspace_path,
        &["--version"],
        abort.clone(),
    )
    .await?;
    if let Some(code) = command_failure_code(&version, WorkspaceCode::GitWorkspaceUnavailable) {
        return Ok(ProjectWorkspaceInspection::Unavailable {
            code: code.as_str(),
        });
    }
    let probe = git(
        commands,
        host_environment,
        workspace_path,
        &["rev-parse", "--is-inside-work-tree"],
        abort.clone(),
    )
    .await?;
    if probe.error.is_none()
        && (probe.exit_code != Some(0)
            || crate::public_text::trim_js_whitespace(&probe.stdout) != "true")
    {
        return Ok(ProjectWorkspaceInspection::Folder);
    }
    if let Some(code) = command_failure_code(&probe, WorkspaceCode::GitWorkspaceUnavailable) {
        return Ok(ProjectWorkspaceInspection::Unavailable {
            code: code.as_str(),
        });
    }
    let branch = git(
        commands,
        host_environment,
        workspace_path,
        &["branch", "--show-current"],
        abort.clone(),
    )
    .await?;
    if command_failure(&branch, WorkspaceCode::GitWorkspaceUnavailable).is_some() {
        return Ok(ProjectWorkspaceInspection::Unavailable {
            code: "git_workspace_unavailable",
        });
    }
    let status = git(
        commands,
        host_environment,
        workspace_path,
        &["status", "--porcelain=v1", "-z", "--untracked-files=all"],
        abort,
    )
    .await?;
    if command_failure(&status, WorkspaceCode::GitWorkspaceUnavailable).is_some() {
        return Ok(ProjectWorkspaceInspection::Unavailable {
            code: "git_workspace_unavailable",
        });
    }
    let branch = crate::public_text::trim_js_whitespace(&branch.stdout);
    let branch: String = branch
        .chars()
        .filter(|character| {
            let code = *character as u32;
            code > 31 && code != 127
        })
        .take(80)
        .collect();
    Ok(ProjectWorkspaceInspection::Git {
        branch: (!branch.is_empty()).then_some(branch),
        dirty: !status.stdout.is_empty(),
    })
}

pub(super) async fn validate_linked_worktree(
    commands: &NativeCommands,
    files: &NativeWorkspaceFiles,
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
    let top_failure = {
        let top = git(
            commands,
            host_environment,
            target,
            &["rev-parse", "--show-toplevel"],
            abort.clone(),
        )
        .await?;
        command_failure(&top, WorkspaceCode::SessionWorkspaceUnavailable)
    };
    if let Some(validation) = top_failure {
        return Ok(validation);
    }
    let stdout = {
        let worktrees = git(
            commands,
            host_environment,
            anchor,
            &["worktree", "list", "--porcelain", "-z"],
            abort.clone(),
        )
        .await?;
        if let Some(validation) =
            command_failure(&worktrees, WorkspaceCode::SessionWorkspaceUnavailable)
        {
            return Ok(validation);
        }
        worktrees.stdout
    };
    let target_for_list = target.to_owned();
    let branch_for_list = branch.to_owned();
    let listed = files
        .run(move || listed_worktree_matches(&stdout, &target_for_list, &branch_for_list))
        .await
        .map_err(WorkspaceError::from)?
        .map_err(io_error)?;
    if !listed {
        return Ok(invalid("session_workspace_unavailable"));
    }
    let symbolic_failure = {
        let symbolic = git(
            commands,
            host_environment,
            target,
            &["symbolic-ref", "--quiet", "--short", "HEAD"],
            abort.clone(),
        )
        .await?;
        command_failure(&symbolic, WorkspaceCode::SessionWorkspaceUnavailable).or_else(|| {
            (crate::public_text::trim_js_whitespace(&symbolic.stdout) != branch)
                .then(|| invalid("session_workspace_unavailable"))
        })
    };
    if let Some(validation) = symbolic_failure {
        return Ok(validation);
    }
    let dirty = {
        let status = git(
            commands,
            host_environment,
            target,
            &["status", "--porcelain=v1", "-z", "--untracked-files=all"],
            abort,
        )
        .await?;
        if let Some(validation) =
            command_failure(&status, WorkspaceCode::SessionWorkspaceUnavailable)
        {
            return Ok(validation);
        }
        !status.stdout.is_empty()
    };
    let target_for_final = target.to_owned();
    let path = files
        .run(move || canonical_path(&target_for_final))
        .await
        .map_err(WorkspaceError::from)?
        .map_err(io_error)?;
    Ok(SessionWorkspaceValidation::Valid {
        path: path.to_string_lossy().into_owned(),
        dirty,
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
        .is_some_and(|error| error.code() == "ENOENT")
    {
        Some(WorkspaceCode::GitNotInstalled)
    } else if result.exit_code != Some(0) {
        Some(other_code)
    } else {
        None
    }
}

async fn git(
    commands: &NativeCommands,
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
