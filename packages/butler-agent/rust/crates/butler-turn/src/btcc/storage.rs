//! BTCC-owned SQLite connection lifecycle and serialized execution lane.

mod admission;
mod authority;
mod bootstrap;
mod budget;
mod canonical;
mod changes;
mod checkpoint;
mod writer;
use writer::{configure, run_connection_lane};
mod claims;
mod common;
mod context_compactions;
mod context_documents;
mod correction;
pub use correction::{CorrectionOutcome, run_startup_correction};
mod effects;
mod error;
mod hydration;
mod legacy_cutover;
mod lifecycle;
mod migration;
mod model;
mod operation_input;
mod operation_results;
mod payload;
mod progress;
mod progress_publication;
mod project_work_runtime;
mod read_pool;
mod readiness;
mod repository;
mod runtime_owner;
mod schema;
mod stop;
mod subsession_result;
mod subsessions;
pub(crate) use subsessions::direction_turn_id;
pub(crate) use subsessions::{ChildCompletion, PendingParentInput};
mod task_graphs;
mod timing;
pub use task_graphs::{
    ChildRecord as TaskGraphChildRecord, GraphRecords as TaskGraphRecords,
    GraphScope as TaskGraphScope, ReviewRecord as TaskGraphReviewRecord,
    WorkRecord as TaskGraphWorkRecord,
};
mod canon;
mod tool_journal;
mod transitions;
mod wake;
mod work;

pub(crate) use authority::{SqliteAuthorityReader, SqliteAuthorityRepository};
pub use bootstrap::{
    begin_storage_startup, bootstrap_fresh_storage, read_activated_storage_manifest,
    storage_error_is_corruption, storage_scan_delay, validate_storage_background,
};
pub use context_compactions::{ContextCompactionRecord, ContextCompactionRepository};
pub use context_documents::{ContextDocumentInput, ContextDocumentRead};
pub use effects::StorageEffectJournal;
pub use error::{StorageCode, StorageError};
pub use operation_results::*;
pub use progress_publication::{CommittedProgressEvent, StorageProgressPublication};
pub use project_work_runtime::SqliteProjectWorkRuntime;
pub(in crate::btcc) use project_work_runtime::material::snapshot as project_work_material_snapshot;
pub use repository::BtccRepositories;
pub use subsessions::{
    COMPLETE_WORKER_SQL, ChildEnvelope, ChildRole, DispatchIntent, DispatchMetadata,
    EnvelopeMessage, EnvelopePeer, EnvelopeRaw, EnvelopeRouting, EnvelopeSender,
    NativeStewardContext, OPEN_SUBTASKS_SQL, PacketExecutionMode, PacketPlanAction,
    PacketWorkerProfile, ParentResultInput, ParentResultRoute, ParentWorkRef,
    RESET_DIRECTION_DISPATCH_SQL, RESTORE_WAITING_DIRECTION_SQL, RETRY_WORKER_SQL,
    RUNNING_WORKERS_SQL, SqliteSubsessionRepository, StewardResultInput,
    StoredSubsessionDelegation, StoredSubsessionDirection, SubsessionCreate,
    SubsessionDispatchState, SubsessionPacket, WAITING_WORKERS_SQL, WORKER_RESULT_MARKER_SQL,
    WORKER_TURN_UNSETTLED_SQL, WorkerResultInput, enqueued_workers_sql, subsession_result_id,
};
pub use tool_journal::{
    ToolJournalCloseoutRow, ToolJournalFinish, ToolJournalFinishStatus, ToolJournalRecord,
    ToolJournalRepository, ToolJournalSignature, ToolJournalStart,
};
pub(crate) use wake::WakeAuthorization;
pub use work::{
    PersistedWorkTurnScope, SessionPlanObservation, SessionWorkRepository, WorkStatusObservation,
};

use lifecycle::{join_failed_initialization, join_owner_thread};
use std::path::PathBuf;
use std::sync::Arc;
use std::thread::JoinHandle;

use rusqlite::Connection;
use tokio::sync::{Mutex as AsyncMutex, mpsc, oneshot};

#[cfg(any(test, feature = "test-support"))]
pub(crate) use runtime_owner::ConservativeProcessLiveness;
use runtime_owner::RuntimeOwner;
pub use runtime_owner::{ProcessLiveness, RuntimeOwnerIdentity};

const OPERATION_QUEUE_CAPACITY: usize = 64;

type StorageResult<T> = Result<T, StorageError>;
type DatabaseOperation = Box<dyn FnOnce(&mut Connection, &RuntimeOwner) + Send + 'static>;

/// Whether storage is a durable file (or an in-memory test database).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum StorageProfile {
    Durable,
    #[cfg(any(test, feature = "test-support"))]
    Ephemeral,
}

/// The activated storage manifest storage must match.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct StorageActivation {
    pub manifest_id: String,
}

/// How to open BTCC storage.
pub struct BtccStorageConfig {
    pub path: PathBuf,
    pub profile: StorageProfile,
    pub activation: StorageActivation,
    pub runtime_owner: RuntimeOwnerIdentity,
    pub process_liveness: Arc<dyn ProcessLiveness>,
}

/// The BTCC SQLite store: serialized writes and independent committed reads.
#[derive(Clone)]
pub struct BtccStorage {
    inner: Arc<StorageInner>,
}

struct StorageInner {
    payload: payload::PayloadMemo,
    changes: tokio::sync::watch::Sender<()>,
    lane: AsyncMutex<LaneState>,
    readers: Option<Arc<read_pool::ReadPool>>,
}

struct LaneState {
    sender: Option<mpsc::Sender<DatabaseOperation>>,
    thread: Option<JoinHandle<StorageResult<()>>>,
    close_result: Option<StorageResult<()>>,
    close_waiters: Vec<oneshot::Sender<StorageResult<()>>>,
}

impl BtccStorage {
    /// Opens the store, verifying its activation and runtime owner.
    pub async fn open(config: BtccStorageConfig) -> StorageResult<Self> {
        let (sender, receiver) = mpsc::channel(OPERATION_QUEUE_CAPACITY);
        let (changes, _) = tokio::sync::watch::channel(());
        let (initialized_tx, initialized_rx) = oneshot::channel();
        let path = config.path;
        let read_path = path.clone();
        let profile = config.profile;
        let activation = config.activation;
        let identity = config.runtime_owner;
        let liveness = config.process_liveness;
        let thread = std::thread::Builder::new()
            .name("butler-btcc-sqlite".to_owned())
            .spawn(move || {
                run_connection_lane(
                    &path,
                    profile,
                    &activation,
                    identity,
                    liveness,
                    receiver,
                    initialized_tx,
                )
            })
            .map_err(|error| {
                StorageError::new(StorageCode::SqliteThreadSpawnFailed, error.to_string())
                    .with_source(error)
            })?;

        let initialized = initialized_rx.await.map_err(|source| {
            StorageError::new(
                StorageCode::SqliteInitializationChannelClosed,
                "BTCC SQLite owner exited before initialization completed",
            )
            .with_source(source)
        });
        let owner = match initialized {
            Ok(Ok(owner)) => owner,
            Ok(Err(error)) | Err(error) => {
                join_failed_initialization(thread).await;
                return Err(error);
            }
        };
        let readers = match read_pool::open(read_path, profile).await {
            Ok(readers) => readers,
            Err(error) => {
                drop(sender);
                join_failed_initialization(thread).await;
                return Err(error);
            }
        };
        let _ = owner;
        Ok(Self {
            inner: Arc::new(StorageInner {
                payload: Default::default(),
                changes,
                readers,
                lane: AsyncMutex::new(LaneState {
                    sender: Some(sender),
                    thread: Some(thread),
                    close_result: None,
                    close_waiters: Vec::new(),
                }),
            }),
        })
    }

    pub(super) fn execute<T, F>(
        &self,
        operation: F,
    ) -> impl std::future::Future<Output = StorageResult<T>> + Send + '_
    where
        T: Send + 'static,
        F: FnOnce(&mut Connection) -> StorageResult<T> + Send + 'static,
    {
        self.execute_with_owner(move |connection, _owner| operation(connection))
    }

    async fn complete<T: Send + 'static>(
        &self,
        job: DatabaseOperation,
        completion_rx: oneshot::Receiver<StorageResult<T>>,
    ) -> StorageResult<T> {
        self.admit(job).await?;
        completion_rx.await.map_err(|source| {
            StorageError::new(
                StorageCode::SqliteOperationCompletionLost,
                "BTCC SQLite operation ended without a completion result",
            )
            .with_source(source)
        })?
    }

    /// Closes the store once; every caller receives the owner thread's result.
    pub async fn close(&self) -> StorageResult<()> {
        if let Some(pool) = &self.inner.readers {
            pool.close().await;
        }
        let (waiter_tx, waiter_rx) = oneshot::channel();
        let mut lane = self.inner.lane.lock().await;
        if let Some(result) = &lane.close_result {
            return result.clone();
        }
        let thread = if lane.sender.take().is_some() {
            match lane.thread.take() {
                Some(thread) => Some(thread),
                None => {
                    let error = StorageError::new(
                        StorageCode::SqliteThreadMissing,
                        "BTCC SQLite owner thread was unavailable during close",
                    );
                    lane.close_result = Some(Err(error.clone()));
                    return Err(error);
                }
            }
        } else {
            None
        };
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
            StorageError::new(
                StorageCode::SqliteCloseCompletionLost,
                "BTCC SQLite close ended without a completion result",
            )
            .with_source(source)
        })?
    }
}

impl Drop for StorageInner {
    fn drop(&mut self) {
        if let Ok(mut lane) = self.lane.try_lock() {
            lane.sender.take();
            // Dropping the final sender drains admitted jobs. The thread owns
            // owner-row closure and Connection destruction; Drop never reports success.
            lane.thread.take();
        }
    }
}

#[cfg(test)]
mod guided_budget_tests;
#[cfg(test)]
mod progress_tests;
#[cfg(test)]
mod readiness_tests;
#[cfg(test)]
pub(crate) mod repository_tests;
#[cfg(any(test, feature = "test-support"))]
pub(crate) mod testing;
#[cfg(any(test, feature = "test-support"))]
pub use testing::{Fixture as TestStorageFixture, prepared as test_prepared_turn};
#[cfg(test)]
mod tests;
#[cfg(test)]
mod transition_tests;

#[cfg(feature = "test-support")]
pub fn pending_ask_plan_statements() -> Vec<(String, &'static str)> {
    authority::pending_ask_statements()
}
#[cfg(feature = "test-support")]
pub fn existing_ask_plan_statements() -> Vec<String> {
    authority::existing_ask_statements()
}
#[cfg(feature = "test-support")]
pub fn pending_ask_projection_schema() -> &'static str {
    schema::pending_asks::SCHEMA
}
