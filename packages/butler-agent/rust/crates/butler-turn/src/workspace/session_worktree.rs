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

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum SessionWorktreeAction {
    Create,
    Select,
}

pub struct BindSessionWorktreeInput {
    pub action: SessionWorktreeAction,
    pub branch: String,
    pub start_point: Option<String>,
    pub session_id: String,
    pub project_name: Option<String>,
    pub workspace_reference: WorkspaceReference,
    pub abort: CancellationToken,
}

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

/// A bind step's result: a value, or the failure the bind reports.
type BindStep<T> = WorkspaceResult<Result<T, BindSessionWorktreeResult>>;

/// The facts a successful bind reports.
struct Bound<'a> {
    action: SessionWorktreeAction,
    branch: &'a str,
    dirty: bool,
    source_dirty: bool,
    idempotent: bool,
}

/// Whether the bound worktree already existed or this bind created it.
#[derive(Clone, Copy, PartialEq, Eq)]
enum TargetOrigin {
    Reused,
    Created,
}

/// The worktree a bind resolves to.
struct Target {
    path: String,
    origin: TargetOrigin,
}

/// The git side of one bind request.
struct BindAttempt<'a> {
    git: GitWorktrees<'a>,
    action: SessionWorktreeAction,
    branch: &'a str,
    abort: CancellationToken,
}

impl BindAttempt<'_> {
    fn fail(&self, code: &'static str) -> BindSessionWorktreeResult {
        failure(self.action, Some(self.branch), code)
    }

    /// Selects the existing worktree of the branch, or creates (or reuses) the
    /// one at the prepared path.
    async fn resolve_target(
        &self,
        anchor: &str,
        created_path: Option<String>,
        start_point: Option<String>,
    ) -> BindStep<Target> {
        let entries = match self.git.list(anchor, self.abort.clone()).await? {
            Ok(entries) => entries,
            Err(code) => return Ok(Err(self.fail(code.as_str()))),
        };
        let branch_entries: Vec<_> = entries
            .iter()
            .filter(|entry| entry.branch.as_deref() == Some(self.branch))
            .collect();
        if self.action == SessionWorktreeAction::Select {
            let Some(selected) = branch_entries.first() else {
                return Ok(Err(self.fail("linked_worktree_not_found")));
            };
            return Ok(Ok(Target {
                path: selected.path.to_string_lossy().into_owned(),
                origin: TargetOrigin::Reused,
            }));
        }
        let Some(target) = created_path else {
            return Ok(Err(self.fail("git_operation_failed")));
        };
        let mut target_entry = None;
        for entry in &entries {
            if self
                .git
                .same_path(&entry.path.to_string_lossy(), &target)
                .await?
            {
                target_entry = Some(entry);
                break;
            }
        }
        let target_on_branch =
            target_entry.is_some_and(|entry| entry.branch.as_deref() == Some(self.branch));
        if !branch_entries.is_empty() && !target_on_branch {
            return Ok(Err(self.fail("branch_already_checked_out")));
        }
        if target_on_branch {
            return Ok(Ok(Target {
                path: target,
                origin: TargetOrigin::Reused,
            }));
        }
        if target_entry.is_some() || self.git.occupied(&target).await? {
            return Ok(Err(self.fail("worktree_target_occupied")));
        }
        self.add_worktree(anchor, target, start_point).await
    }

    /// `git worktree add` for an existing local branch, or with `-b` from the
    /// start point (default `HEAD`).
    async fn add_worktree(
        &self,
        anchor: &str,
        target: String,
        start_point: Option<String>,
    ) -> BindStep<Target> {
        let exists = self
            .git
            .local_branch_exists(anchor, self.branch, self.abort.clone())
            .await?;
        let args = if exists {
            vec![
                "worktree".into(),
                "add".into(),
                target.clone(),
                self.branch.into(),
            ]
        } else {
            vec![
                "worktree".into(),
                "add".into(),
                "-b".into(),
                self.branch.into(),
                target.clone(),
                start_point.unwrap_or_else(|| "HEAD".into()),
            ]
        };
        let created = self.git.run(anchor, args, self.abort.clone()).await?;
        if let Some(code) = git::command_failure(&created, WorkspaceCode::GitOperationFailed) {
            return self
                .cancel_or_fail(Some(&target), anchor, code.as_str())
                .await
                .map(Err);
        }
        Ok(Ok(Target {
            path: target,
            origin: TargetOrigin::Created,
        }))
    }

    /// Validates the worktree and reads whether the source checkout is dirty.
    async fn inspect(&self, anchor: &str, target: &Target) -> BindStep<(Validated, bool)> {
        let validated = match self
            .git
            .validate(anchor, &target.path, self.branch, self.abort.clone())
            .await?
        {
            Ok(value) => value,
            Err(code) => return self.probe_failed(anchor, target, code).await.map(Err),
        };
        match self.git.dirty(anchor, self.abort.clone()).await? {
            Ok(source_dirty) => Ok(Ok((validated, source_dirty))),
            Err(code) => self.probe_failed(anchor, target, code).await.map(Err),
        }
    }

    /// A cancelled probe of a worktree this bind created may have left a
    /// partial creation behind; other probe failures report their code.
    async fn probe_failed(
        &self,
        anchor: &str,
        target: &Target,
        code: WorkspaceCode,
    ) -> WorkspaceResult<BindSessionWorktreeResult> {
        if code == WorkspaceCode::Cancelled
            && target.origin == TargetOrigin::Created
            && self.action == SessionWorktreeAction::Create
        {
            return self
                .cancel_or_fail(Some(&target.path), anchor, code.as_str())
                .await;
        }
        Ok(self.fail(code.as_str()))
    }

    async fn cancel_or_fail(
        &self,
        target: Option<&str>,
        anchor: &str,
        code: &'static str,
    ) -> WorkspaceResult<BindSessionWorktreeResult> {
        if (code == "cancelled" || code == "git_operation_failed")
            && let Some(target) = target
            && self
                .git
                .partial_creation(anchor, target, self.branch)
                .await?
        {
            return Ok(self.fail("partial_creation"));
        }
        Ok(self.fail(code))
    }
}
