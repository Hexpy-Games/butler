//! Durable runtime session bindings owned by the workspace domain.

mod bindings;
mod commands;
mod discovery;
mod effect_file;
mod file_owner;
mod files;
mod grep;
mod mutations;
mod path_guard;
mod reference;
mod session_recovery;
mod session_worktree;
mod status;

pub(crate) use commands::{
    CommandStep, GuidedAccess, GuidedCommandInput, GuidedCommandOutput, GuidedSummary, LegacyShell,
    NativeCommands, StructuredCommandInput, StructuredCommandOutput,
};
pub(crate) use discovery::{
    WorkspaceListEntry, WorkspaceListInput, WorkspaceListLimits, WorkspaceListOutcome,
    WorkspaceListRejection, WorkspaceListResult,
};
pub(crate) use effect_file::{
    EffectFileError, EffectFileObservation, EffectFileScope, guard_effect_file,
    observe_effect_file, read_effect_edit_target,
};
pub(crate) use file_owner::{FileOwnerError, NativeWorkspaceFiles};
pub(crate) use files::{ReadFileInput, WorkspaceFileRead, cursor_path, utf8_prefix_end};
pub(crate) use grep::{GrepCandidate, GrepMatch, GrepRead};
pub(crate) use mutations::net_changed_file_detail;
pub(crate) use mutations::prepare_exact_text;
pub(crate) use mutations::{
    BatchResult, ChangedFile, CommittedFile, EditFailure, EditMutation, EditedFile, ExactEdit,
    MutationCommand, MutationContext, MutationOutcome, MutationOwnerError, WorkspaceMutations,
    WriteMutation,
};
pub(crate) use path_guard::safe_workspace_path;
pub(crate) use reference::WorkspaceReference;
pub(crate) use session_recovery::{
    NativeSessionWorkspaceRecovery, ProjectWorkspaceInspection, SessionWorkspaceAuthority,
    SessionWorkspaceValidation,
};
pub(crate) use session_worktree::{
    BindSessionWorktreeInput, BindSessionWorktreeResult, NativeSessionWorktrees,
    RelocationWorkspaceInput, RelocationWorkspaceMarker, RelocationWorkspacePlan,
    SessionWorktreeAction, short_session_worktree_branch,
};
pub(crate) use status::{StatusSessionIdentity, read_active_butler_session};

pub(crate) use bindings::*;

use std::fmt;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::thread::JoinHandle;
use std::time::Duration;

use rusqlite::Connection;
use tokio::sync::{Mutex, mpsc, oneshot};

const OPERATION_QUEUE_CAPACITY: usize = 64;

pub(crate) fn session_store_path(butler_data: &Path) -> PathBuf {
    butler_data.join("runtime/session-store.sqlite")
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum WorkspaceStorageProfile {
    Durable,
    #[cfg(test)]
    Ephemeral,
}

pub(crate) trait WorkspaceClock: Send + Sync {
    fn now_epoch_millis(&self) -> i64;
    fn parse_iso_millis(&self, value: &str) -> Option<i64>;
    fn iso_from_epoch_millis(&self, value: i64) -> WorkspaceResult<String>;
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct WorkspaceError {
    pub(crate) code: &'static str,
    pub(crate) message: String,
}

impl WorkspaceError {
    pub(crate) fn new(code: &'static str, message: impl Into<String>) -> Self {
        Self {
            code,
            message: message.into(),
        }
    }

    #[expect(
        clippy::needless_pass_by_value,
        reason = "map_err/iterator adapter taking owned values"
    )]
    fn sqlite(error: rusqlite::Error) -> Self {
        Self::new("workspace_sqlite_error", error.to_string())
    }

    fn json(error: impl fmt::Display) -> Self {
        Self::new("workspace_json_error", error.to_string())
    }
}

impl fmt::Display for WorkspaceError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(formatter, "{}: {}", self.code, self.message)
    }
}

impl std::error::Error for WorkspaceError {}

pub(crate) type WorkspaceResult<T> = Result<T, WorkspaceError>;
type DatabaseOperation = Box<dyn FnOnce(&mut Connection) + Send + 'static>;

pub(crate) struct SessionBindingStoreConfig {
    pub path: PathBuf,
    pub storage_profile: WorkspaceStorageProfile,
    pub clock: Arc<dyn WorkspaceClock>,
}

#[derive(Clone)]
pub(crate) struct SessionBindingStore {
    inner: Arc<StoreInner>,
}

struct StoreInner {
    lane: Mutex<LaneState>,
    clock: Arc<dyn WorkspaceClock>,
}

struct LaneState {
    sender: Option<mpsc::Sender<DatabaseOperation>>,
    thread: Option<JoinHandle<WorkspaceResult<()>>>,
    close_result: Option<WorkspaceResult<()>>,
    close_waiters: Vec<oneshot::Sender<WorkspaceResult<()>>>,
}

impl SessionBindingStore {
    pub(crate) async fn open(config: SessionBindingStoreConfig) -> WorkspaceResult<Self> {
        let (sender, receiver) = mpsc::channel(OPERATION_QUEUE_CAPACITY);
        let (initialized_tx, initialized_rx) = oneshot::channel();
        let path = config.path.clone();
        let profile = config.storage_profile;
        let thread = std::thread::Builder::new()
            .name("butler-workspace-bindings-sqlite".into())
            .spawn(move || run_connection_lane(path, profile, receiver, initialized_tx))
            .map_err(|error| {
                WorkspaceError::new("workspace_thread_spawn_failed", error.to_string())
            })?;
        match initialized_rx.await {
            Ok(Ok(())) => Ok(Self {
                inner: Arc::new(StoreInner {
                    lane: Mutex::new(LaneState {
                        sender: Some(sender),
                        thread: Some(thread),
                        close_result: None,
                        close_waiters: Vec::new(),
                    }),
                    clock: config.clock,
                }),
            }),
            Ok(Err(error)) => {
                join_failed_initialization(thread).await;
                Err(error)
            }
            Err(_) => {
                join_failed_initialization(thread).await;
                Err(WorkspaceError::new(
                    "workspace_initialization_lost",
                    "Workspace SQLite owner exited before initialization completed",
                ))
            }
        }
    }

    pub(super) fn clock(&self) -> &Arc<dyn WorkspaceClock> {
        &self.inner.clock
    }

    pub(super) async fn execute<T, F>(&self, operation: F) -> WorkspaceResult<T>
    where
        T: Send + 'static,
        F: FnOnce(&mut Connection) -> WorkspaceResult<T> + Send + 'static,
    {
        let (completion_tx, completion_rx) = oneshot::channel();
        let job: DatabaseOperation = Box::new(move |connection| {
            let _ignored_cancelled_caller = completion_tx.send(operation(connection));
        });
        let lane = self.inner.lane.lock().await;
        let sender = lane.sender.as_ref().ok_or_else(|| {
            WorkspaceError::new("workspace_closed", "Workspace binding store is closing")
        })?;
        let permit = sender.reserve().await.map_err(|_| {
            WorkspaceError::new("workspace_closed", "Workspace execution lane closed")
        })?;
        permit.send(job);
        drop(lane);
        completion_rx.await.map_err(|_| {
            WorkspaceError::new(
                "workspace_completion_lost",
                "Workspace operation ended without completion",
            )
        })?
    }

    pub(crate) async fn close(&self) -> WorkspaceResult<()> {
        let (waiter_tx, waiter_rx) = oneshot::channel();
        let mut lane = self.inner.lane.lock().await;
        if let Some(result) = &lane.close_result {
            return result.clone();
        }
        let thread = if lane.sender.take().is_some() {
            lane.thread.take()
        } else {
            None
        };
        if lane.thread.is_none() && thread.is_none() && lane.close_waiters.is_empty() {
            let error = WorkspaceError::new(
                "workspace_thread_missing",
                "Workspace SQLite owner thread is unavailable",
            );
            lane.close_result = Some(Err(error.clone()));
            return Err(error);
        }
        lane.close_waiters.push(waiter_tx);
        drop(lane);
        if let Some(thread) = thread {
            let inner = Arc::clone(&self.inner);
            tokio::spawn(async move {
                let result = tokio::task::spawn_blocking(move || thread.join())
                    .await
                    .map_err(|error| {
                        WorkspaceError::new("workspace_join_failed", error.to_string())
                    })
                    .and_then(|joined| {
                        joined.map_err(|_| {
                            WorkspaceError::new(
                                "workspace_thread_panicked",
                                "Workspace SQLite owner thread panicked",
                            )
                        })?
                    });
                let mut lane = inner.lane.lock().await;
                lane.close_result = Some(result.clone());
                let waiters = std::mem::take(&mut lane.close_waiters);
                drop(lane);
                for waiter in waiters {
                    let _ignored_cancelled_closer = waiter.send(result.clone());
                }
            });
        }
        waiter_rx.await.map_err(|_| {
            WorkspaceError::new(
                "workspace_close_completion_lost",
                "Workspace close ended without completion",
            )
        })?
    }
}

impl Drop for StoreInner {
    fn drop(&mut self) {
        if let Ok(mut lane) = self.lane.try_lock() {
            lane.sender.take();
            lane.thread.take();
        }
    }
}

fn run_connection_lane(
    path: PathBuf,
    profile: WorkspaceStorageProfile,
    mut receiver: mpsc::Receiver<DatabaseOperation>,
    initialized: oneshot::Sender<WorkspaceResult<()>>,
) -> WorkspaceResult<()> {
    let setup = (|| {
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent).map_err(|error| {
                WorkspaceError::new("workspace_parent_create_failed", error.to_string())
            })?;
        }
        let connection = Connection::open(path).map_err(WorkspaceError::sqlite)?;
        connection
            .busy_timeout(Duration::from_millis(5_000))
            .map_err(WorkspaceError::sqlite)?;
        let journal_mode = match profile {
            WorkspaceStorageProfile::Durable => "WAL",
            #[cfg(test)]
            WorkspaceStorageProfile::Ephemeral => "DELETE",
        };
        connection
            .pragma_update(None, "journal_mode", journal_mode)
            .map_err(WorkspaceError::sqlite)?;
        connection
            .pragma_update(None, "foreign_keys", "ON")
            .map_err(WorkspaceError::sqlite)?;
        connection
            .pragma_update(None, "synchronous", "NORMAL")
            .map_err(WorkspaceError::sqlite)?;
        bindings::schema::ensure(&connection)?;
        Ok::<_, WorkspaceError>(connection)
    })();
    let mut connection = match setup {
        Ok(connection) => connection,
        Err(error) => {
            let _ignored_closed_opener = initialized.send(Err(error.clone()));
            return Err(error);
        }
    };
    if initialized.send(Ok(())).is_err() {
        return Ok(());
    }
    while let Some(operation) = receiver.blocking_recv() {
        operation(&mut connection);
    }
    if !connection.is_autocommit() {
        return Err(WorkspaceError::new(
            "workspace_transaction_open_at_close",
            "Workspace transaction remained open at close",
        ));
    }
    connection
        .close()
        .map_err(|(_, error)| WorkspaceError::sqlite(error))
}

async fn join_failed_initialization(thread: JoinHandle<WorkspaceResult<()>>) {
    let _ignored_initialization_result = tokio::task::spawn_blocking(move || thread.join()).await;
}

#[cfg(test)]
mod tests;
