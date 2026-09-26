//! Prepare-only worktree operations used by the App session relocation owner.

mod cleanup;

use std::path::Path;

use super::{NativeSessionWorktrees, Owner, git::GitWorktrees, path};
use crate::workspace::{WorkspaceError, WorkspaceResult};
use serde::{Deserialize, Serialize};
use tokio::sync::oneshot;

const MARKER_SCHEMA: &str = "butler.session-workspace-binding.v1";

#[derive(Clone, Debug)]
pub(crate) struct RelocationWorkspaceInput {
    pub runtime_session_id: String,
    pub operation_id: String,
    pub project_path: Option<String>,
    pub project_name: Option<String>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct RelocationWorkspacePlan {
    pub runtime_session_id: String,
    pub operation_id: String,
    pub workspace_path: String,
    pub marker: Option<RelocationWorkspaceMarker>,
    pub created: bool,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct RelocationWorkspaceMarker {
    pub schema: String,
    pub ownership: String,
    pub repository_anchor_path: String,
    pub branch: String,
    pub bound_at: String,
}

impl NativeSessionWorktrees {
    pub(crate) async fn plan_relocation(
        &self,
        input: RelocationWorkspaceInput,
    ) -> WorkspaceResult<RelocationWorkspacePlan> {
        self.submit(move |owner| async move { owner.plan_relocation(input).await })
            .await
    }

    pub(crate) async fn prepare_relocation(
        &self,
        plan: RelocationWorkspacePlan,
    ) -> WorkspaceResult<RelocationWorkspacePlan> {
        self.submit(move |owner| async move { owner.prepare_relocation(plan).await })
            .await
    }

    pub(crate) async fn discard_relocation(
        &self,
        plan: RelocationWorkspacePlan,
    ) -> WorkspaceResult<bool> {
        self.submit(move |owner| async move { cleanup::discard(owner.as_ref(), plan).await })
            .await
    }

    async fn submit<T, F, Fut>(&self, operation: F) -> WorkspaceResult<T>
    where
        T: Send + 'static,
        F: FnOnce(std::sync::Arc<Owner>) -> Fut + Send + 'static,
        Fut: std::future::Future<Output = WorkspaceResult<T>> + Send + 'static,
    {
        let (tx, rx) = oneshot::channel();
        {
            let state = self.inner.state.lock();
            if state.closing {
                return Err(WorkspaceError::new(
                    "session_worktree_owner_closed",
                    "Session worktree owner is closed",
                ));
            }
            let owner = std::sync::Arc::clone(&self.inner);
            self.inner.jobs.spawn(async move {
                let _ = tx.send(operation(owner).await);
            });
        }
        rx.await.map_err(|_| {
            WorkspaceError::new(
                "session_worktree_owner_lost",
                "Session worktree operation stopped",
            )
        })?
    }
}

impl Owner {
    async fn plan_relocation(
        &self,
        input: RelocationWorkspaceInput,
    ) -> WorkspaceResult<RelocationWorkspacePlan> {
        let session_id = input.runtime_session_id.clone();
        let lock = self.session_lock(&session_id);
        let result = {
            let _guard = lock.lock().await;
            self.plan_relocation_unlocked(input).await
        };
        self.release_session_lock(&session_id, &lock);
        result
    }

    async fn plan_relocation_unlocked(
        &self,
        input: RelocationWorkspaceInput,
    ) -> WorkspaceResult<RelocationWorkspacePlan> {
        let Some(project_path) = input.project_path.as_deref() else {
            let data = self.butler_data.clone();
            let workspace_path = self
                .files
                .run(move || path::canonical_path(&data.to_string_lossy()))
                .await
                .map_err(file_owner_error)?
                .map_err(io_error)?
                .to_string_lossy()
                .into_owned();
            return Ok(RelocationWorkspacePlan {
                runtime_session_id: input.runtime_session_id,
                operation_id: input.operation_id,
                workspace_path,
                marker: None,
                created: false,
            });
        };
        let project_path = project_path.to_owned();
        let canonical_project = self
            .files
            .run(move || {
                let canonical = path::canonical_path(&project_path)?;
                if !canonical.is_dir() {
                    return Err(std::io::Error::other("workspace is not a directory"));
                }
                Ok(canonical)
            })
            .await
            .map_err(file_owner_error)?
            .map_err(io_error)?;
        let canonical_project = canonical_project.to_string_lossy().into_owned();
        let git = self.git();
        let anchor = match git.repository_anchor(&canonical_project).await? {
            Ok(anchor) => anchor,
            Err("git_repository_required") => {
                return Ok(RelocationWorkspacePlan {
                    runtime_session_id: input.runtime_session_id,
                    operation_id: input.operation_id,
                    workspace_path: canonical_project,
                    marker: None,
                    created: false,
                });
            }
            Err(code) => return Err(workspace_error(code)),
        };
        let branch = super::short_session_worktree_branch(&format!(
            "{}:{}",
            input.runtime_session_id, input.operation_id
        ));
        let data = self.butler_data.clone();
        let session = input.runtime_session_id.clone();
        let branch_for_path = branch.clone();
        let project_name = input.project_name.clone();
        let target = self
            .files
            .run(move || {
                path::deterministic_target(
                    &data,
                    &session,
                    &branch_for_path,
                    project_name.as_deref(),
                )
            })
            .await
            .map_err(file_owner_error)?
            .map_err(io_error)?;
        let entries = git
            .list(&anchor, self.shutdown.child_token())
            .await?
            .map_err(workspace_error)?;
        let mut existing = false;
        for entry in entries {
            if entry.branch.as_deref() == Some(branch.as_str())
                && git
                    .same_path(&entry.path.to_string_lossy(), &target)
                    .await?
            {
                existing = true;
                break;
            }
        }
        if !existing && git.occupied(&target).await? {
            return Err(workspace_error("worktree_target_occupied"));
        }
        let bound_at = self
            .clock
            .iso_from_epoch_millis(self.clock.now_epoch_millis())?;
        Ok(RelocationWorkspacePlan {
            runtime_session_id: input.runtime_session_id,
            operation_id: input.operation_id,
            workspace_path: target,
            marker: Some(RelocationWorkspaceMarker {
                schema: MARKER_SCHEMA.into(),
                ownership: "session".into(),
                repository_anchor_path: anchor,
                branch,
                bound_at,
            }),
            // The plan records ownership of the deterministic target whether
            // it already exists or is created by the following prepare step.
            created: true,
        })
    }

    async fn prepare_relocation(
        &self,
        plan: RelocationWorkspacePlan,
    ) -> WorkspaceResult<RelocationWorkspacePlan> {
        let lock = self.session_lock(&plan.runtime_session_id);
        let result = {
            let _guard = lock.lock().await;
            self.prepare_relocation_unlocked(plan.clone()).await
        };
        self.release_session_lock(&plan.runtime_session_id, &lock);
        result
    }

    async fn prepare_relocation_unlocked(
        &self,
        plan: RelocationWorkspacePlan,
    ) -> WorkspaceResult<RelocationWorkspacePlan> {
        let Some(marker) = plan.marker.as_ref() else {
            return Ok(plan);
        };
        self.validate_plan_path(&plan).await?;
        let data = self.butler_data.clone();
        let target = plan.workspace_path.clone();
        self.files
            .run(move || path::ensure_target_root(&data, &target))
            .await
            .map_err(file_owner_error)?
            .map_err(io_error)?;
        let git = self.git();
        let abort = self.shutdown.child_token();
        let entries = git
            .list(&marker.repository_anchor_path, abort.clone())
            .await?
            .map_err(workspace_error)?;
        let mut existing = false;
        for entry in entries {
            if entry.branch.as_deref() == Some(marker.branch.as_str())
                && git
                    .same_path(&entry.path.to_string_lossy(), &plan.workspace_path)
                    .await?
            {
                existing = true;
                break;
            }
        }
        if !existing && git.occupied(&plan.workspace_path).await? {
            return Err(workspace_error("worktree_target_occupied"));
        }
        if !existing {
            let output = git
                .run(
                    &marker.repository_anchor_path,
                    vec![
                        "worktree".into(),
                        "add".into(),
                        "-b".into(),
                        marker.branch.clone(),
                        plan.workspace_path.clone(),
                        "HEAD".into(),
                    ],
                    abort.clone(),
                )
                .await?;
            if let Some(code) = super::git::command_failure(&output, "worktree_preparation_failed")
            {
                return Err(workspace_error(code));
            }
        }
        match git
            .validate(
                &marker.repository_anchor_path,
                &plan.workspace_path,
                &marker.branch,
                abort,
            )
            .await?
        {
            Ok(_) => Ok(plan),
            Err(code) => Err(workspace_error(code)),
        }
    }

    fn git(&self) -> GitWorktrees<'_> {
        GitWorktrees::new(&self.commands, &self.files, &self.host_environment)
    }

    async fn validate_plan_path(&self, plan: &RelocationWorkspacePlan) -> WorkspaceResult<()> {
        validate_plan(plan)?;
        let data = self.butler_data.clone();
        let target = plan.workspace_path.clone();
        self.files
            .run(move || path::validate_target_root(&data, &target))
            .await
            .map_err(file_owner_error)?
            .map_err(io_error)
    }
}

fn validate_plan(plan: &RelocationWorkspacePlan) -> WorkspaceResult<()> {
    let Some(marker) = plan.marker.as_ref() else {
        return Err(workspace_error("relocation_plan_invalid"));
    };
    if marker.schema != MARKER_SCHEMA
        || marker.ownership != "session"
        || !Path::new(&marker.repository_anchor_path).is_absolute()
        || !path::safe_ref(&marker.branch, false)
        || plan.operation_id.is_empty()
    {
        return Err(workspace_error("relocation_plan_invalid"));
    }
    Ok(())
}

fn workspace_error(code: &'static str) -> WorkspaceError {
    WorkspaceError::new(code, "Session relocation workspace operation failed")
}

fn io_error(error: std::io::Error) -> WorkspaceError {
    WorkspaceError::new("session_worktree_io", error.to_string())
}

fn file_owner_error(error: crate::workspace::FileOwnerError) -> WorkspaceError {
    WorkspaceError::new(error.code, "Workspace file owner closed")
}
