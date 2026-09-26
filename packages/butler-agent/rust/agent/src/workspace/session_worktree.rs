//! Session-owned Git worktree binding; the session binding remains the authority.

mod git;
mod path;
mod relocation;
#[cfg(test)]
mod tests;

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::{Arc, Mutex, Weak};

use serde_json::Map;
use tokio::sync::oneshot;
use tokio_util::sync::CancellationToken;
use tokio_util::task::TaskTracker;

use super::{
    NativeCommands, NativeWorkspaceFiles, RebindWorkspaceInput, RebindWorkspaceResult,
    SessionBindingStore, WorkspaceClock, WorkspaceReference, WorkspaceResult,
};
use git::GitWorktrees;
use path::{marker, normalize_ref, public_label, safe_ref};

pub(crate) use path::short_session_worktree_branch;
pub(crate) use relocation::{
    RelocationWorkspaceInput, RelocationWorkspaceMarker, RelocationWorkspacePlan,
};

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum SessionWorktreeAction {
    Create,
    Select,
}

pub(crate) struct BindSessionWorktreeInput {
    pub action: SessionWorktreeAction,
    pub branch: String,
    pub start_point: Option<String>,
    pub session_id: String,
    pub project_name: Option<String>,
    pub workspace_reference: WorkspaceReference,
    pub abort: CancellationToken,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) enum BindSessionWorktreeResult {
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
pub(crate) struct NativeSessionWorktrees {
    inner: Arc<Owner>,
}

struct Owner {
    bindings: SessionBindingStore,
    commands: NativeCommands,
    files: NativeWorkspaceFiles,
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

impl NativeSessionWorktrees {
    pub(crate) fn new(
        bindings: SessionBindingStore,
        commands: NativeCommands,
        files: NativeWorkspaceFiles,
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

    pub(crate) async fn bind(
        &self,
        input: BindSessionWorktreeInput,
    ) -> WorkspaceResult<BindSessionWorktreeResult> {
        let (tx, rx) = oneshot::channel();
        {
            let state = self
                .inner
                .state
                .lock()
                .expect("session worktree owner poisoned");
            if state.closing {
                return Ok(failure(input.action, None, "cancelled"));
            }
            let owner = Arc::clone(&self.inner);
            self.inner.jobs.spawn(async move {
                let result = owner.bind_owned(input).await;
                let _ = tx.send(result);
            });
        }
        rx.await.map_err(|_| {
            super::WorkspaceError::new(
                "session_worktree_owner_lost",
                "Session worktree operation stopped",
            )
        })?
    }

    pub(crate) async fn close(&self) {
        {
            let mut state = self
                .inner
                .state
                .lock()
                .expect("session worktree owner poisoned");
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
                tokio::select! { _ = caller.cancelled() => stop.cancel(), _ = stop.cancelled() => {} }
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
        let mut state = self.state.lock().expect("session worktree owner poisoned");
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
        let mut state = self.state.lock().expect("session worktree owner poisoned");
        if Arc::strong_count(lock) == 1
            && state
                .locks
                .get(session_id)
                .is_some_and(|entry| entry.ptr_eq(&Arc::downgrade(lock)))
        {
            state.locks.remove(session_id);
        }
    }

    async fn bind_unlocked(
        &self,
        input: BindSessionWorktreeInput,
        branch: &str,
        abort: CancellationToken,
    ) -> WorkspaceResult<BindSessionWorktreeResult> {
        let action = input.action;
        if !safe_ref(branch, false) {
            return Ok(failure(action, None, "invalid_branch"));
        }
        if action == SessionWorktreeAction::Select && input.start_point.is_some() {
            return Ok(failure(action, Some(branch), "invalid_start_point"));
        }
        let start_point = input.start_point.as_deref().map(normalize_ref);
        if action == SessionWorktreeAction::Create
            && start_point
                .as_ref()
                .is_some_and(|value| !safe_ref(value, true))
        {
            return Ok(failure(action, Some(branch), "invalid_start_point"));
        }
        if abort.is_cancelled() {
            return Ok(failure(action, Some(branch), "cancelled"));
        }
        let Some(binding) = self.bindings.get_by_session_id(&input.session_id).await? else {
            return Ok(failure(action, Some(branch), "session_binding_required"));
        };
        let existing_marker = match path::read_marker(binding.metadata.as_ref()) {
            Ok(value) => value,
            Err(()) => {
                return Ok(failure(
                    action,
                    Some(branch),
                    "session_workspace_unavailable",
                ));
            }
        };
        let anchor_path = existing_marker
            .as_ref()
            .map_or(binding.workspace_path.as_str(), |value| {
                value.repository_anchor_path.as_str()
            });
        let git = GitWorktrees::new(&self.commands, &self.files, &self.host_environment);
        let anchor = match git.repository_anchor(anchor_path).await? {
            Ok(path) => path,
            Err(code) => return Ok(failure(action, Some(branch), code)),
        };
        let target = if action == SessionWorktreeAction::Create {
            let data = self.butler_data.clone();
            let session = input.session_id.clone();
            let branch_for_path = branch.to_owned();
            let project = input.project_name.clone();
            let prepared = self
                .files
                .run(move || {
                    path::prepare_target(&data, &session, &branch_for_path, project.as_deref())
                })
                .await;
            match prepared {
                Ok(Ok(path)) => Some(path),
                _ => {
                    return Ok(failure(action, Some(branch), "worktree_target_occupied"));
                }
            }
        } else {
            None
        };
        if let Some(code) = git
            .failure(
                &anchor,
                &["check-ref-format", "--branch", branch],
                abort.clone(),
                "invalid_branch",
            )
            .await?
        {
            return self
                .cancel_or_fail(&git, action, branch, target.as_deref(), &anchor, code)
                .await;
        }
        let entries = match git.list(&anchor, abort.clone()).await? {
            Ok(entries) => entries,
            Err(code) => return Ok(failure(action, Some(branch), code)),
        };
        let branch_entries: Vec<_> = entries
            .iter()
            .filter(|entry| entry.branch.as_deref() == Some(branch))
            .collect();
        let same_marker = existing_marker
            .as_ref()
            .is_some_and(|value| value.branch == branch);
        let (target, reusable, idempotent) = if action == SessionWorktreeAction::Select {
            let Some(selected) = branch_entries.first() else {
                return Ok(failure(action, Some(branch), "linked_worktree_not_found"));
            };
            let path = selected.path.to_string_lossy().into_owned();
            let same = same_marker && git.same_path(&path, &binding.workspace_path).await?;
            (path, true, same)
        } else {
            let target = target.expect("create target prepared");
            let mut target_entry = None;
            for entry in &entries {
                if git
                    .same_path(&entry.path.to_string_lossy(), &target)
                    .await?
                {
                    target_entry = Some(entry);
                    break;
                }
            }
            if !branch_entries.is_empty()
                && target_entry.is_none_or(|entry| entry.branch.as_deref() != Some(branch))
            {
                return Ok(failure(action, Some(branch), "branch_already_checked_out"));
            }
            if target_entry.is_some_and(|entry| entry.branch.as_deref() == Some(branch)) {
                let same = same_marker && git.same_path(&binding.workspace_path, &target).await?;
                (target, true, same)
            } else if target_entry.is_some() || git.occupied(&target).await? {
                return Ok(failure(action, Some(branch), "worktree_target_occupied"));
            } else {
                let exists = git
                    .local_branch_exists(&anchor, branch, abort.clone())
                    .await?;
                let args = if exists {
                    vec![
                        "worktree".into(),
                        "add".into(),
                        target.clone(),
                        branch.into(),
                    ]
                } else {
                    vec![
                        "worktree".into(),
                        "add".into(),
                        "-b".into(),
                        branch.into(),
                        target.clone(),
                        start_point.unwrap_or_else(|| "HEAD".into()),
                    ]
                };
                let created = git.run(&anchor, args, abort.clone()).await?;
                if let Some(code) = git::command_failure(&created, "git_operation_failed") {
                    return self
                        .cancel_or_fail(&git, action, branch, Some(&target), &anchor, code)
                        .await;
                }
                (target, false, false)
            }
        };
        let validated = match git
            .validate(&anchor, &target, branch, abort.clone())
            .await?
        {
            Ok(value) => value,
            Err(code) => {
                if code == "cancelled" && !reusable && action == SessionWorktreeAction::Create {
                    return self
                        .cancel_or_fail(&git, action, branch, Some(&target), &anchor, code)
                        .await;
                }
                return Ok(failure(action, Some(branch), code));
            }
        };
        let source_dirty = match git.dirty(&anchor, abort.clone()).await? {
            Ok(value) => value,
            Err(code) => {
                if code == "cancelled" && !reusable && action == SessionWorktreeAction::Create {
                    return self
                        .cancel_or_fail(&git, action, branch, Some(&target), &anchor, code)
                        .await;
                }
                return Ok(failure(action, Some(branch), code));
            }
        };
        let now = self
            .clock
            .iso_from_epoch_millis(self.clock.now_epoch_millis())?;
        let mut metadata = binding.metadata.unwrap_or_else(Map::new);
        metadata.insert("sessionWorkspace".into(), marker(&anchor, branch, &now));
        let result = self
            .bindings
            .rebind_workspace(RebindWorkspaceInput {
                session_id: input.session_id,
                expected_updated_at: binding.updated_at,
                workspace_path: validated.path.clone(),
                metadata,
                updated_at: Some(now),
            })
            .await;
        let persisted = match result {
            Ok(value) => value,
            Err(_) => return Ok(failure(action, Some(branch), "binding_persist_failed")),
        };
        match persisted {
            RebindWorkspaceResult::Missing => {
                return Ok(failure(action, Some(branch), "session_binding_required"));
            }
            RebindWorkspaceResult::Changed(_) => {
                return Ok(failure(action, Some(branch), "session_binding_changed"));
            }
            RebindWorkspaceResult::Applied(_) => {}
        }
        input
            .workspace_reference
            .set(&validated.path)
            .map_err(|error| {
                super::WorkspaceError::new("workspace_reference_failed", error.code)
            })?;
        Ok(BindSessionWorktreeResult::Bound {
            action,
            workspace_label: public_label(branch),
            branch: branch.into(),
            dirty: validated.dirty,
            source_dirty,
            idempotent,
        })
    }

    async fn cancel_or_fail(
        &self,
        git: &GitWorktrees<'_>,
        action: SessionWorktreeAction,
        branch: &str,
        target: Option<&str>,
        anchor: &str,
        code: &'static str,
    ) -> WorkspaceResult<BindSessionWorktreeResult> {
        if (code == "cancelled" || code == "git_operation_failed")
            && target.is_some()
            && git
                .partial_creation(anchor, target.unwrap(), branch)
                .await?
        {
            return Ok(failure(action, Some(branch), "partial_creation"));
        }
        Ok(failure(action, Some(branch), code))
    }
}
