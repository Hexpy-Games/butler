//! Durable runtime session bindings owned by the workspace domain.

mod bindings;
mod commands;
mod discovery;
mod effect_file;
mod error;
mod file_owner;
mod files;
mod grep;
mod mutations;
mod path_guard;
pub(crate) use path_guard::realpath_or_nearest;
mod reference;
mod session_recovery;
mod session_worktree;
mod status;

pub use commands::{
    CommandCode, CommandError, CommandStep, Commands, GuidedAccess, GuidedCommandInput,
    GuidedCommandOutput, GuidedSummary, LegacyShell, StructuredCommandInput,
    StructuredCommandOutput,
};
pub use discovery::{
    ListStop, WorkspaceListEntry, WorkspaceListInput, WorkspaceListLimits, WorkspaceListOutcome,
    WorkspaceListRejection, WorkspaceListResult,
};
pub use effect_file::{
    EffectFileError, EffectFileObservation, EffectFileScope, guard_effect_file,
    observe_effect_file, read_effect_edit_target,
};
pub use error::{WorkspaceCode, WorkspaceError};
pub use file_owner::{FileOwnerError, WorkspaceFiles};
pub use files::{ReadFileInput, WorkspaceFileRead, cursor_path, utf8_prefix_end};
pub use grep::{GrepCandidate, GrepMatch, GrepRead};
pub use mutations::{
    BatchResult, ChangedFile, CommittedFile, EditFailure, EditMutation, EditedFile, ExactEdit,
    MutationCommand, MutationContext, MutationOutcome, MutationOwnerError, WorkspaceMutations,
    WriteMutation,
};
pub use mutations::{net_changed_file_detail, prepare_exact_text};
pub use path_guard::{PathForm, looks_sensitive, safe_workspace_path};
pub use reference::WorkspaceReference;
pub use session_recovery::{
    ProjectGitStatus, ProjectWorkspaceInspection, SessionWorkspaceAuthority,
    SessionWorkspaceRecovery, SessionWorkspaceValidation,
};
pub use session_worktree::{
    BindSessionWorktreeInput, BindSessionWorktreeResult, RelocationWorkspaceInput,
    RelocationWorkspaceMarker, RelocationWorkspacePlan, SessionWorktreeAction, SessionWorktrees,
    short_session_worktree_branch,
};
pub use status::{StatusSessionIdentity, read_active_butler_session};

pub use bindings::*;

use butler_platform::sqlite;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::thread::JoinHandle;
use std::time::Duration;

use rusqlite::Connection;
use tokio::sync::{Mutex, mpsc, oneshot};

const OPERATION_QUEUE_CAPACITY: usize = 64;

/// The session store file under the Butler data directory.
pub fn session_store_path(butler_data: &Path) -> PathBuf {
    butler_data.join("runtime/session-store.sqlite")
}

/// Whether the session store is a durable file (or in-memory for tests).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum WorkspaceStorageProfile {
    Durable,
    #[cfg(any(test, feature = "test-support"))]
    Ephemeral,
}

/// Time source of the session store.
pub trait WorkspaceClock: Send + Sync {
    /// The current time in epoch milliseconds.
    fn now_epoch_millis(&self) -> i64;
    /// Parses an ISO timestamp.
    fn parse_iso_millis(&self, value: &str) -> Option<i64>;
    /// Formats epoch milliseconds as ISO.
    fn iso_from_epoch_millis(&self, value: i64) -> WorkspaceResult<String>;
}

/// The result of a workspace operation.
pub type WorkspaceResult<T> = Result<T, WorkspaceError>;
type DatabaseOperation = Box<dyn FnOnce(&mut Connection) + Send + 'static>;

/// How to open the session store.
pub struct SessionBindingStoreConfig {
    pub path: PathBuf,
    pub storage_profile: WorkspaceStorageProfile,
    pub clock: Arc<dyn WorkspaceClock>,
}

/// The session binding store; every operation runs on its owner thread.
#[derive(Clone)]
pub struct SessionBindingStore {
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
    /// Opens the store.
    pub async fn open(config: SessionBindingStoreConfig) -> WorkspaceResult<Self> {
        let (sender, receiver) = mpsc::channel(OPERATION_QUEUE_CAPACITY);
        let (initialized_tx, initialized_rx) = oneshot::channel();
        let path = config.path.clone();
        let profile = config.storage_profile;
        let thread = std::thread::Builder::new()
            .name("butler-workspace-bindings-sqlite".into())
            .spawn(move || run_connection_lane(path, profile, receiver, initialized_tx))
            .map_err(|error| {
                WorkspaceError::new(WorkspaceCode::WorkspaceThreadSpawnFailed, error.to_string())
                    .with_source(error)
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
                    WorkspaceCode::WorkspaceInitializationLost,
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
            WorkspaceError::new(
                WorkspaceCode::WorkspaceClosed,
                "Workspace binding store is closing",
            )
        })?;
        let permit = sender.reserve().await.map_err(|source| {
            WorkspaceError::new(
                WorkspaceCode::WorkspaceClosed,
                "Workspace execution lane closed",
            )
            .with_source(source)
        })?;
        permit.send(job);
        drop(lane);
        completion_rx.await.map_err(|source| {
            WorkspaceError::new(
                WorkspaceCode::WorkspaceCompletionLost,
                "Workspace operation ended without completion",
            )
            .with_source(source)
        })?
    }

    /// Closes the store once; every caller receives the owner thread's result.
    pub async fn close(&self) -> WorkspaceResult<()> {
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
                WorkspaceCode::WorkspaceThreadMissing,
                "Workspace SQLite owner thread is unavailable",
            );
            lane.close_result = Some(Err(error.clone()));
            return Err(error);
        }
        lane.close_waiters.push(waiter_tx);
        drop(lane);
        if let Some(thread) = thread {
            let inner = Arc::clone(&self.inner);
            // Detached on purpose: close waiters receive the join result, and the join
            // must finish even when the caller that started closing is cancelled.
            tokio::spawn(async move {
                let result = join_owner_thread(thread).await;
                let mut lane = inner.lane.lock().await;
                lane.close_result = Some(result.clone());
                let waiters = std::mem::take(&mut lane.close_waiters);
                drop(lane);
                for waiter in waiters {
                    let _ignored_cancelled_closer = waiter.send(result.clone());
                }
            });
        }
        waiter_rx.await.map_err(|source| {
            WorkspaceError::new(
                WorkspaceCode::WorkspaceCloseCompletionLost,
                "Workspace close ended without completion",
            )
            .with_source(source)
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
                WorkspaceError::new(
                    WorkspaceCode::WorkspaceParentCreateFailed,
                    error.to_string(),
                )
                .with_source(error)
            })?;
        }
        let connection = sqlite::open(path).map_err(WorkspaceError::sqlite)?;
        connection
            .busy_timeout(Duration::from_millis(5_000))
            .map_err(WorkspaceError::sqlite)?;
        let journal_mode = match profile {
            WorkspaceStorageProfile::Durable => "WAL",
            #[cfg(any(test, feature = "test-support"))]
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
            WorkspaceCode::WorkspaceTransactionOpenAtClose,
            "Workspace transaction remained open at close",
        ));
    }
    // NORMAL commits are durable once the WAL is synced. Keep it for recovery
    // instead of copying and syncing the same pages again at final close.
    sqlite::sync_wal(&connection).map_err(|error| {
        WorkspaceError::new(WorkspaceCode::SqliteWalSyncFailed, error.to_string())
            .with_source(error)
    })?;
    connection
        .set_db_config(
            rusqlite::config::DbConfig::SQLITE_DBCONFIG_NO_CKPT_ON_CLOSE,
            true,
        )
        .map_err(WorkspaceError::sqlite)?;
    connection
        .close()
        .map_err(|(_, error)| WorkspaceError::sqlite(error))
}

async fn join_failed_initialization(thread: JoinHandle<WorkspaceResult<()>>) {
    let _ignored_initialization_result = tokio::task::spawn_blocking(move || thread.join()).await;
}

#[cfg(test)]
mod tests;

/// Joins the SQLite owner thread off the async runtime; a panic is reported
/// with its own code (the payload is not an error).
async fn join_owner_thread(
    thread: std::thread::JoinHandle<WorkspaceResult<()>>,
) -> WorkspaceResult<()> {
    let joined = tokio::task::spawn_blocking(move || thread.join())
        .await
        .map_err(|error| {
            WorkspaceError::new(WorkspaceCode::WorkspaceJoinFailed, error.to_string())
                .with_source(error)
        })?;
    joined.map_err(|_panic_payload| {
        WorkspaceError::new(
            WorkspaceCode::WorkspaceThreadPanicked,
            "Workspace SQLite owner thread panicked",
        )
    })?
}
