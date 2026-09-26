use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::Arc;

use tokio_util::sync::CancellationToken;

use super::path::{canonical_path, linked_directory, occupied};
use crate::workspace::WorkspaceCode;
use crate::workspace::session_recovery::path::{WorktreeEntry, parse_worktrees};
use crate::workspace::{
    CommandStep, NativeCommands, NativeWorkspaceFiles, StructuredCommandInput,
    StructuredCommandOutput, WorkspaceError, WorkspaceResult,
};

pub(super) type GitOutcome<T> = Result<T, WorkspaceCode>;

pub(super) struct Validated {
    pub path: String,
    pub dirty: bool,
}

pub(super) struct GitWorktrees<'a> {
    commands: &'a NativeCommands,
    files: &'a NativeWorkspaceFiles,
    host_environment: &'a Arc<HashMap<String, String>>,
}

impl<'a> GitWorktrees<'a> {
    pub(super) fn new(
        commands: &'a NativeCommands,
        files: &'a NativeWorkspaceFiles,
        host_environment: &'a Arc<HashMap<String, String>>,
    ) -> Self {
        Self {
            commands,
            files,
            host_environment,
        }
    }

    pub(super) async fn run(
        &self,
        cwd: &str,
        args: Vec<String>,
        abort: CancellationToken,
    ) -> WorkspaceResult<StructuredCommandOutput> {
        let input = StructuredCommandInput {
            steps: vec![CommandStep {
                executable: "git".into(),
                arguments: args,
            }],
            cwd: Some(PathBuf::from(cwd)),
            environment: HashMap::new(),
            host_environment: (**self.host_environment).clone(),
            inherit_environment: true,
            stdin: String::new(),
            timeout_ms: Some(30_000.0),
            abort,
            legacy: None,
        };
        self.commands
            .submit_structured(input)
            .map_err(WorkspaceError::from)?
            .await
            .map_err(|source| {
                WorkspaceError::new(WorkspaceCode::SessionWorktreeCommandLost, "Git result lost")
                    .with_source(source)
            })
    }

    pub(super) async fn failure(
        &self,
        cwd: &str,
        args: &[&str],
        abort: CancellationToken,
        other: WorkspaceCode,
    ) -> WorkspaceResult<Option<WorkspaceCode>> {
        let output = self
            .run(cwd, args.iter().map(|arg| (*arg).into()).collect(), abort)
            .await?;
        Ok(command_failure(&output, other))
    }

    pub(super) async fn repository_anchor(
        &self,
        path: &str,
    ) -> WorkspaceResult<GitOutcome<String>> {
        let path = path.to_owned();
        let candidate = self
            .files
            .run(move || {
                let canonical = canonical_path(&path)?;
                if !canonical.exists() {
                    return Ok::<_, std::io::Error>((None, false));
                }
                if !canonical.metadata().is_ok_and(|metadata| metadata.is_dir()) {
                    return Ok((None, true));
                }
                Ok((Some(canonical.to_string_lossy().into_owned()), false))
            })
            .await
            .map_err(WorkspaceError::from)?
            .map_err(io_error)?;
        let (candidate, not_directory) = candidate;
        let Some(candidate) = candidate else {
            return Ok(Err(if not_directory {
                WorkspaceCode::GitRepositoryRequired
            } else {
                WorkspaceCode::SessionWorkspaceUnavailable
            }));
        };
        let result = self
            .run(
                &candidate,
                vec!["rev-parse".into(), "--show-toplevel".into()],
                CancellationToken::new(),
            )
            .await?;
        if result
            .error
            .as_ref()
            .is_some_and(|error| error.code() == "ENOENT")
        {
            return Ok(Err(WorkspaceCode::GitNotInstalled));
        }
        let top = crate::public_text::trim_js_whitespace(&result.stdout);
        if result.exit_code != Some(0) || top.is_empty() {
            return Ok(Err(WorkspaceCode::GitRepositoryRequired));
        }
        let top = top.to_owned();
        let canonical = self
            .files
            .run(move || canonical_path(&top))
            .await
            .map_err(WorkspaceError::from)?
            .map_err(io_error)?;
        Ok(Ok(canonical.to_string_lossy().into_owned()))
    }

    pub(super) async fn list(
        &self,
        anchor: &str,
        abort: CancellationToken,
    ) -> WorkspaceResult<GitOutcome<Vec<WorktreeEntry>>> {
        let result = self
            .run(
                anchor,
                vec![
                    "worktree".into(),
                    "list".into(),
                    "--porcelain".into(),
                    "-z".into(),
                ],
                abort,
            )
            .await?;
        if let Some(code) = command_failure(&result, WorkspaceCode::GitRepositoryRequired) {
            return Ok(Err(code));
        }
        let entries = self
            .files
            .run(move || parse_worktrees(&result.stdout))
            .await
            .map_err(WorkspaceError::from)?
            .map_err(io_error)?;
        Ok(Ok(entries))
    }

    pub(super) async fn same_path(&self, left: &str, right: &str) -> WorkspaceResult<bool> {
        let left = left.to_owned();
        let right = right.to_owned();
        self.files
            .run(move || Ok::<_, std::io::Error>(canonical_path(&left)? == canonical_path(&right)?))
            .await
            .map_err(WorkspaceError::from)?
            .map_err(io_error)
    }

    pub(super) async fn occupied(&self, path: &str) -> WorkspaceResult<bool> {
        let path = path.to_owned();
        self.files
            .run(move || occupied(&path))
            .await
            .map_err(WorkspaceError::from)
    }

    pub(super) async fn local_branch_exists(
        &self,
        anchor: &str,
        branch: &str,
        abort: CancellationToken,
    ) -> WorkspaceResult<bool> {
        let result = self
            .run(
                anchor,
                vec![
                    "show-ref".into(),
                    "--verify".into(),
                    "--quiet".into(),
                    format!("refs/heads/{branch}"),
                ],
                abort,
            )
            .await?;
        Ok(result.exit_code == Some(0))
    }

    pub(super) async fn validate(
        &self,
        anchor: &str,
        target: &str,
        branch: &str,
        abort: CancellationToken,
    ) -> WorkspaceResult<GitOutcome<Validated>> {
        if abort.is_cancelled() {
            return Ok(Err(WorkspaceCode::Cancelled));
        }
        let path = target.to_owned();
        if !self
            .files
            .run(move || linked_directory(&path))
            .await
            .map_err(WorkspaceError::from)?
        {
            return Ok(Err(WorkspaceCode::LinkedWorktreeNotFound));
        }
        let top = self
            .run(
                target,
                vec!["rev-parse".into(), "--show-toplevel".into()],
                abort.clone(),
            )
            .await?;
        if let Some(code) = command_failure(&top, WorkspaceCode::GitRepositoryRequired) {
            return Ok(Err(code));
        }
        let listed = match self.list(anchor, abort.clone()).await? {
            Ok(value) => value,
            Err(code) => return Ok(Err(code)),
        };
        let mut found = false;
        for entry in listed {
            if entry.branch.as_deref() == Some(branch)
                && self
                    .same_path(&entry.path.to_string_lossy(), target)
                    .await?
            {
                found = true;
                break;
            }
        }
        if !found {
            return Ok(Err(WorkspaceCode::PartialCreation));
        }
        let symbolic = self
            .run(
                target,
                vec![
                    "symbolic-ref".into(),
                    "--quiet".into(),
                    "--short".into(),
                    "HEAD".into(),
                ],
                abort.clone(),
            )
            .await?;
        if let Some(code) = command_failure(&symbolic, WorkspaceCode::PartialCreation) {
            return Ok(Err(code));
        }
        if crate::public_text::trim_js_whitespace(&symbolic.stdout) != branch {
            return Ok(Err(WorkspaceCode::PartialCreation));
        }
        let dirty = match self.dirty(target, abort).await? {
            Ok(value) => value,
            Err(code) => return Ok(Err(code)),
        };
        let path = target.to_owned();
        let canonical = self
            .files
            .run(move || canonical_path(&path))
            .await
            .map_err(WorkspaceError::from)?
            .map_err(io_error)?;
        Ok(Ok(Validated {
            path: canonical.to_string_lossy().into_owned(),
            dirty,
        }))
    }

    pub(super) async fn dirty(
        &self,
        path: &str,
        abort: CancellationToken,
    ) -> WorkspaceResult<GitOutcome<bool>> {
        let status = self
            .run(
                path,
                vec![
                    "status".into(),
                    "--porcelain=v1".into(),
                    "-z".into(),
                    "--untracked-files=all".into(),
                ],
                abort,
            )
            .await?;
        if let Some(code) = command_failure(&status, WorkspaceCode::GitRepositoryRequired) {
            return Ok(Err(code));
        }
        Ok(Ok(!status.stdout.is_empty()))
    }

    pub(super) async fn partial_creation(
        &self,
        anchor: &str,
        target: &str,
        branch: &str,
    ) -> WorkspaceResult<bool> {
        let target_path = target.to_owned();
        if !self
            .files
            .run(move || std::path::Path::new(&target_path).exists())
            .await
            .map_err(WorkspaceError::from)?
        {
            return Ok(false);
        }
        let Ok(entries) = self.list(anchor, CancellationToken::new()).await? else {
            return Ok(false);
        };
        for entry in entries {
            if entry.branch.as_deref() == Some(branch)
                && self
                    .same_path(&entry.path.to_string_lossy(), target)
                    .await?
            {
                return Ok(true);
            }
        }
        Ok(false)
    }
}

pub(super) fn command_failure(
    result: &StructuredCommandOutput,
    other: WorkspaceCode,
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
        Some(other)
    } else {
        None
    }
}

fn io_error(error: std::io::Error) -> WorkspaceError {
    WorkspaceError::new(WorkspaceCode::SessionWorktreeIo, error.to_string()).with_source(error)
}
