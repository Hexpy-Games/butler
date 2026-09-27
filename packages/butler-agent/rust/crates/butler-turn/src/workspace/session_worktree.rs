//! Session-owned Git worktree binding; the session binding remains the authority.

mod git;
mod path;
mod relocation;
#[cfg(test)]
mod tests;

use parking_lot::Mutex;
use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::{Arc, Weak};

use tokio::sync::oneshot;
use tokio_util::sync::CancellationToken;
use tokio_util::task::TaskTracker;

use super::{
    Commands, RebindWorkspaceInput, RebindWorkspaceResult, SessionBindingStore,
    StoredSessionBinding, WorkspaceClock, WorkspaceFiles, WorkspaceReference, WorkspaceResult,
};
use git::{GitWorktrees, Validated};
use path::{BindingMarker, marker, normalize_ref, public_label, safe_ref};

use crate::workspace::WorkspaceCode;
pub use path::short_session_worktree_branch;
pub use relocation::{
    RelocationWorkspaceInput, RelocationWorkspaceMarker, RelocationWorkspacePlan,
};

mod attempt;
use attempt::*;

/// Whether to create or select a session worktree.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum SessionWorktreeAction {
    Create,
    Select,
}

/// Binds a session to a git worktree of a branch.
pub struct BindSessionWorktreeInput {
    pub action: SessionWorktreeAction,
    pub branch: String,
    pub start_point: Option<String>,
    pub session_id: String,
    pub project_name: Option<String>,
    pub workspace_reference: WorkspaceReference,
    pub abort: CancellationToken,
}

/// A bound worktree, or why binding failed.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum BindSessionWorktreeResult {
    Bound {
        action: SessionWorktreeAction,
        workspace_label: String,
        branch: String,
        dirty: bool,
        source_dirty: bool,
        idempotent: bool,
    },
    Failed {
        code: &'static str,
        action: SessionWorktreeAction,
        branch: Option<String>,
    },
}

fn failure(
    action: SessionWorktreeAction,
    branch: Option<&str>,
    code: &'static str,
) -> BindSessionWorktreeResult {
    BindSessionWorktreeResult::Failed {
        code,
        action,
        branch: branch.filter(|value| !value.is_empty()).map(str::to_owned),
    }
}

type SessionLock = tokio::sync::Mutex<()>;

/// Binds sessions to git worktrees, one operation per session at a time.
#[derive(Clone)]
pub struct SessionWorktrees {
    inner: Arc<Owner>,
}

struct Owner {
    bindings: SessionBindingStore,
    commands: Commands,
    files: WorkspaceFiles,
    host_environment: Arc<HashMap<String, String>>,
    butler_data: PathBuf,
    clock: Arc<dyn WorkspaceClock>,
    state: Mutex<State>,
    jobs: TaskTracker,
    shutdown: CancellationToken,
}

struct State {
    closing: bool,
    locks: HashMap<String, Weak<SessionLock>>,
}

impl SessionWorktrees {
    /// An owner over the bindings, commands, files and Butler data.
    pub fn new(
        bindings: SessionBindingStore,
        commands: Commands,
        files: WorkspaceFiles,
        host_environment: Arc<HashMap<String, String>>,
        butler_data: PathBuf,
        clock: Arc<dyn WorkspaceClock>,
    ) -> Self {
        Self {
            inner: Arc::new(Owner {
                bindings,
                commands,
                files,
                host_environment,
                butler_data,
                clock,
                state: Mutex::new(State {
                    closing: false,
                    locks: HashMap::new(),
                }),
                jobs: TaskTracker::new(),
                shutdown: CancellationToken::new(),
            }),
        }
    }

    /// Binds (creating or selecting) a session worktree.
    pub async fn bind(
        &self,
        input: BindSessionWorktreeInput,
    ) -> WorkspaceResult<BindSessionWorktreeResult> {
        let (tx, rx) = oneshot::channel();
        {
            let state = self.inner.state.lock();
            if state.closing {
                return Ok(failure(input.action, None, "cancelled"));
            }
            let owner = Arc::clone(&self.inner);
            self.inner.jobs.spawn(async move {
                let result = owner.bind_owned(input).await;
                let _ = tx.send(result);
            });
        }
        rx.await.map_err(|source| {
            super::WorkspaceError::new(
                WorkspaceCode::SessionWorktreeOwnerLost,
                "Session worktree operation stopped",
            )
            .with_source(source)
        })?
    }

    /// Refuses new operations and waits for running ones.
    pub async fn close(&self) {
        {
            let mut state = self.inner.state.lock();
            state.closing = true;
            self.inner.shutdown.cancel();
            self.inner.jobs.close();
        }
        self.inner.jobs.wait().await;
    }
}

impl Owner {
    async fn bind_owned(
        self: &Arc<Self>,
        input: BindSessionWorktreeInput,
    ) -> WorkspaceResult<BindSessionWorktreeResult> {
        let branch = normalize_ref(&input.branch);
        // TS obtains the session lock before validation. Keep the lock across every await and CAS.
        let session_id = input.session_id.clone();
        let lock = self.session_lock(&session_id);
        let result = {
            let _guard = lock.lock().await;
            let joined = self.shutdown.child_token();
            let caller = input.abort.clone();
            if caller.is_cancelled() {
                joined.cancel();
            }
            let stop = joined.clone();
            let watcher = tokio::spawn(async move {
                tokio::select! { () = caller.cancelled() => stop.cancel(), () = stop.cancelled() => {} }
            });
            let result = self.bind_unlocked(input, &branch, joined.clone()).await;
            joined.cancel();
            let _ = watcher.await;
            result
        };
        // The last completed waiter removes this entry; a newly enqueued waiter retains its Arc.
        {
            self.release_session_lock(&session_id, &lock);
        }
        result
    }

    fn session_lock(&self, session_id: &str) -> Arc<SessionLock> {
        let mut state = self.state.lock();
        let lock = state
            .locks
            .get(session_id)
            .and_then(Weak::upgrade)
            .unwrap_or_else(|| Arc::new(SessionLock::new(())));
        state
            .locks
            .insert(session_id.to_owned(), Arc::downgrade(&lock));
        lock
    }

    fn release_session_lock(&self, session_id: &str, lock: &Arc<SessionLock>) {
        let mut state = self.state.lock();
        if Arc::strong_count(lock) == 1
            && state
                .locks
                .get(session_id)
                .is_some_and(|entry| entry.ptr_eq(&Arc::downgrade(lock)))
        {
            state.locks.remove(session_id);
        }
    }

    /// Binds the session to a linked worktree: validates the request, resolves
    /// or creates the worktree, inspects it and persists the rebinding.
    async fn bind_unlocked(
        &self,
        input: BindSessionWorktreeInput,
        branch: &str,
        abort: CancellationToken,
    ) -> WorkspaceResult<BindSessionWorktreeResult> {
        let action = input.action;
        let start_point = match validate_request(&input, branch, &abort) {
            Ok(start_point) => start_point,
            Err(failed) => return Ok(failed),
        };
        let attempt = BindAttempt {
            git: GitWorktrees::new(&self.commands, &self.files, &self.host_environment),
            action,
            branch,
            abort,
        };
        let (binding, existing_marker, anchor) =
            match self.load_anchor(&attempt, &input.session_id).await? {
                Ok(loaded) => loaded,
                Err(failed) => return Ok(failed),
            };
        let created_path = match action {
            SessionWorktreeAction::Create => match self.prepare_target_path(&input, branch).await {
                Some(path) => Some(path),
                None => return Ok(attempt.fail("worktree_target_occupied")),
            },
            SessionWorktreeAction::Select => None,
        };
        if let Some(code) = attempt
            .git
            .failure(
                &anchor,
                &["check-ref-format", "--branch", branch],
                attempt.abort.clone(),
                WorkspaceCode::InvalidBranch,
            )
            .await?
        {
            return attempt
                .cancel_or_fail(created_path.as_deref(), &anchor, code.as_str())
                .await;
        }
        let target = match attempt
            .resolve_target(&anchor, created_path, start_point)
            .await?
        {
            Ok(target) => target,
            Err(failed) => return Ok(failed),
        };
        let same_marker = existing_marker
            .as_ref()
            .is_some_and(|value| value.branch == branch);
        let idempotent = target.origin == TargetOrigin::Reused
            && same_marker
            && attempt
                .git
                .same_path(&target.path, &binding.workspace_path)
                .await?;
        let (validated, source_dirty) = match attempt.inspect(&anchor, &target).await? {
            Ok(inspected) => inspected,
            Err(failed) => return Ok(failed),
        };
        let bound = Bound {
            action,
            branch,
            dirty: validated.dirty,
            source_dirty,
            idempotent,
        };
        self.commit_binding(&attempt, input, binding, &anchor, &validated.path, bound)
            .await
    }

    /// Records the worktree marker on the binding (compare-and-swap), points
    /// the workspace reference at the worktree and reports it bound.
    async fn commit_binding(
        &self,
        attempt: &BindAttempt<'_>,
        input: BindSessionWorktreeInput,
        binding: StoredSessionBinding,
        anchor: &str,
        path: &str,
        bound: Bound<'_>,
    ) -> WorkspaceResult<BindSessionWorktreeResult> {
        let now = self
            .clock
            .iso_from_epoch_millis(self.clock.now_epoch_millis())?;
        let mut metadata = binding.metadata.unwrap_or_default();
        metadata.insert(
            "sessionWorkspace".into(),
            marker(anchor, bound.branch, &now),
        );
        let rebind = RebindWorkspaceInput {
            session_id: input.session_id,
            expected_updated_at: binding.updated_at,
            workspace_path: path.to_owned(),
            metadata,
            updated_at: Some(now),
        };
        if let Some(code) = self.persist_rebinding(rebind).await {
            return Ok(attempt.fail(code));
        }
        input.workspace_reference.set(path).map_err(|error| {
            super::WorkspaceError::new(WorkspaceCode::WorkspaceReferenceFailed, error.code())
        })?;
        Ok(BindSessionWorktreeResult::Bound {
            action: bound.action,
            workspace_label: public_label(bound.branch),
            branch: bound.branch.into(),
            dirty: bound.dirty,
            source_dirty: bound.source_dirty,
            idempotent: bound.idempotent,
        })
    }

    /// The session's current binding and the repository anchor its worktree
    /// marker (or workspace) points at.
    async fn load_anchor(
        &self,
        attempt: &BindAttempt<'_>,
        session_id: &str,
    ) -> BindStep<(StoredSessionBinding, Option<BindingMarker>, String)> {
        let Some(binding) = self.bindings.get_by_session_id(session_id).await? else {
            return Ok(Err(attempt.fail("session_binding_required")));
        };
        let Ok(existing_marker) = path::read_marker(binding.metadata.as_ref()) else {
            return Ok(Err(attempt.fail("session_workspace_unavailable")));
        };
        let anchor_path = existing_marker
            .as_ref()
            .map_or(binding.workspace_path.as_str(), |value| {
                value.repository_anchor_path.as_str()
            });
        let anchor = match attempt.git.repository_anchor(anchor_path).await? {
            Ok(path) => path,
            Err(code) => return Ok(Err(attempt.fail(code.as_str()))),
        };
        Ok(Ok((binding, existing_marker, anchor)))
    }

    /// Reserves the directory a created worktree will live in; `None` when it
    /// cannot be prepared.
    async fn prepare_target_path(
        &self,
        input: &BindSessionWorktreeInput,
        branch: &str,
    ) -> Option<String> {
        let data = self.butler_data.clone();
        let session = input.session_id.clone();
        let branch = branch.to_owned();
        let project = input.project_name.clone();
        let prepared = self
            .files
            .run(move || path::prepare_target(&data, &session, &branch, project.as_deref()))
            .await;
        match prepared {
            Ok(Ok(path)) => Some(path),
            _ => None,
        }
    }

    /// Compare-and-swaps the session binding; the failure code when it did not apply.
    async fn persist_rebinding(&self, rebind: RebindWorkspaceInput) -> Option<&'static str> {
        match self.bindings.rebind_workspace(rebind).await {
            Err(_) => Some("binding_persist_failed"),
            Ok(RebindWorkspaceResult::Missing) => Some("session_binding_required"),
            Ok(RebindWorkspaceResult::Changed(_)) => Some("session_binding_changed"),
            Ok(RebindWorkspaceResult::Applied(_)) => None,
        }
    }
}

/// Checks the request before any git work; the normalized start point of a create.
fn validate_request(
    input: &BindSessionWorktreeInput,
    branch: &str,
    abort: &CancellationToken,
) -> Result<Option<String>, BindSessionWorktreeResult> {
    let action = input.action;
    if !safe_ref(branch, false) {
        return Err(failure(action, None, "invalid_branch"));
    }
    if action == SessionWorktreeAction::Select && input.start_point.is_some() {
        return Err(failure(action, Some(branch), "invalid_start_point"));
    }
    let start_point = input.start_point.as_deref().map(normalize_ref);
    if action == SessionWorktreeAction::Create
        && start_point
            .as_ref()
            .is_some_and(|value| !safe_ref(value, true))
    {
        return Err(failure(action, Some(branch), "invalid_start_point"));
    }
    if abort.is_cancelled() {
        return Err(failure(action, Some(branch), "cancelled"));
    }
    Ok(start_point)
}
