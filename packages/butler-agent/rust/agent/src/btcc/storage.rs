//! BTCC-owned SQLite connection lifecycle and serialized execution lane.

mod admission;
mod authority;
mod bootstrap;
mod budget;
mod canonical;
mod claims;
mod common;
mod context_compactions;
mod context_documents;
mod effects;
mod hydration;
mod legacy_cutover;
mod migration;
mod model;
mod operation_input;
mod operation_results;
mod progress;
mod progress_publication;
mod project_work_runtime;
mod readiness;
mod repository;
mod runtime_owner;
mod schema;
mod stop;
mod subsessions;
mod tool_journal;
mod transitions;
mod wake;
mod work;

pub(crate) use authority::SqliteAuthorityRepository;
pub(crate) use bootstrap::{bootstrap_fresh_storage, read_activated_storage_manifest};
pub(crate) use context_compactions::{ContextCompactionRecord, ContextCompactionRepository};
pub(crate) use context_documents::{ContextDocumentInput, ContextDocumentRead};
pub(crate) use effects::StorageEffectJournal;
pub(crate) use operation_results::*;
pub(crate) use progress_publication::{CommittedProgressEvent, StorageProgressPublication};
pub(crate) use project_work_runtime::SqliteProjectWorkRuntime;
pub(in crate::btcc) use project_work_runtime::material::snapshot as project_work_material_snapshot;
pub(crate) use repository::BtccRepositories;
pub(crate) use subsessions::{
    ParentResultRoute, SqliteSubsessionRepository, StoredSubsessionDelegation,
    StoredSubsessionDirection, SubsessionCreate,
};
pub(crate) use tool_journal::{
    ToolJournalCloseoutRow, ToolJournalFinish, ToolJournalFinishStatus, ToolJournalRecord,
    ToolJournalRepository, ToolJournalSignature, ToolJournalStart,
};
pub(crate) use wake::WakeAuthorization;
pub(crate) use work::{
    PersistedWorkTurnScope, SessionPlanObservation, SessionWorkRepository, WorkStatusObservation,
};

use std::fmt;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::thread::JoinHandle;
use std::time::Duration;

use rusqlite::{Connection, OptionalExtension};
use serde_json::Value;
use tokio::sync::{Mutex as AsyncMutex, mpsc, oneshot};

#[cfg(test)]
pub(crate) use runtime_owner::ConservativeProcessLiveness;
use runtime_owner::RuntimeOwner;
pub(crate) use runtime_owner::{ProcessLiveness, RuntimeOwnerIdentity};

const OPERATION_QUEUE_CAPACITY: usize = 64;

type StorageResult<T> = Result<T, StorageError>;
type DatabaseOperation = Box<dyn FnOnce(&mut Connection, &RuntimeOwner) + Send + 'static>;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum StorageProfile {
    Durable,
    #[cfg(test)]
    Ephemeral,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct StorageActivation {
    pub(crate) manifest_id: String,
}

pub(crate) struct BtccStorageConfig {
    pub(crate) path: PathBuf,
    pub(crate) profile: StorageProfile,
    pub(crate) activation: StorageActivation,
    pub(crate) runtime_owner: RuntimeOwnerIdentity,
    pub(crate) process_liveness: Arc<dyn ProcessLiveness>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct StorageError {
    pub(crate) code: &'static str,
    pub(crate) message: String,
}

impl StorageError {
    fn new(code: &'static str, message: impl Into<String>) -> Self {
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
        Self::new("sqlite_error", error.to_string())
    }
}

impl fmt::Display for StorageError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(formatter, "{}: {}", self.code, self.message)
    }
}

impl std::error::Error for StorageError {}

#[derive(Clone)]
pub(crate) struct BtccStorage {
    inner: Arc<StorageInner>,
}

struct StorageInner {
    lane: AsyncMutex<LaneState>,
    #[cfg(test)]
    owner_id: String,
    #[cfg(test)]
    owner_generation: u64,
}

struct LaneState {
    sender: Option<mpsc::Sender<DatabaseOperation>>,
    thread: Option<JoinHandle<StorageResult<()>>>,
    close_result: Option<StorageResult<()>>,
    close_waiters: Vec<oneshot::Sender<StorageResult<()>>>,
}

impl BtccStorage {
    pub(crate) async fn open(config: BtccStorageConfig) -> StorageResult<Self> {
        let (sender, receiver) = mpsc::channel(OPERATION_QUEUE_CAPACITY);
        let (initialized_tx, initialized_rx) = oneshot::channel();
        let path = config.path;
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
            .map_err(|error| StorageError::new("sqlite_thread_spawn_failed", error.to_string()))?;

        let initialized = initialized_rx.await.map_err(|_| {
            StorageError::new(
                "sqlite_initialization_channel_closed",
                "BTCC SQLite owner exited before initialization completed",
            )
        });
        let (_owner_id, _owner_generation) = match initialized {
            Ok(Ok(owner)) => owner,
            Ok(Err(error)) => {
                join_failed_initialization(thread).await;
                return Err(error);
            }
            Err(error) => {
                join_failed_initialization(thread).await;
                return Err(error);
            }
        };
        Ok(Self {
            inner: Arc::new(StorageInner {
                lane: AsyncMutex::new(LaneState {
                    sender: Some(sender),
                    thread: Some(thread),
                    close_result: None,
                    close_waiters: Vec::new(),
                }),
                #[cfg(test)]
                owner_id: _owner_id,
                #[cfg(test)]
                owner_generation: _owner_generation,
            }),
        })
    }

    #[cfg(test)]
    pub(crate) fn owner_id(&self) -> &str {
        &self.inner.owner_id
    }

    #[cfg(test)]
    pub(crate) fn owner_generation(&self) -> u64 {
        self.inner.owner_generation
    }

    pub(super) async fn execute<T, F>(&self, operation: F) -> StorageResult<T>
    where
        T: Send + 'static,
        F: FnOnce(&mut Connection) -> StorageResult<T> + Send + 'static,
    {
        self.execute_with_owner(move |connection, _owner| operation(connection))
            .await
    }

    async fn execute_with_owner<T, F>(&self, operation: F) -> StorageResult<T>
    where
        T: Send + 'static,
        F: FnOnce(&mut Connection, &RuntimeOwner) -> StorageResult<T> + Send + 'static,
    {
        let (completion_tx, completion_rx) = oneshot::channel();
        let job: DatabaseOperation = Box::new(move |connection, owner| {
            let result = operation(connection, owner);
            let _ignored_cancelled_caller = completion_tx.send(result);
        });
        let lane = self.inner.lane.lock().await;
        let sender = lane.sender.as_ref().ok_or_else(|| {
            StorageError::new(
                "sqlite_owner_closed",
                "BTCC SQLite owner is closing or closed",
            )
        })?;
        let permit = sender.reserve().await.map_err(|_| {
            StorageError::new(
                "sqlite_owner_closed",
                "BTCC SQLite execution lane has closed",
            )
        })?;
        permit.send(job);
        drop(lane);
        completion_rx.await.map_err(|_| {
            StorageError::new(
                "sqlite_operation_completion_lost",
                "BTCC SQLite operation ended without a completion result",
            )
        })?
    }

    pub(crate) async fn close(&self) -> StorageResult<()> {
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
                        "sqlite_thread_missing",
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
            tokio::spawn(async move {
                let result = tokio::task::spawn_blocking(move || thread.join())
                    .await
                    .map_err(|error| StorageError::new("sqlite_join_failed", error.to_string()))
                    .and_then(|joined| {
                        joined.map_err(|_| {
                            StorageError::new(
                                "sqlite_thread_panicked",
                                "BTCC SQLite owner thread panicked",
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
            StorageError::new(
                "sqlite_close_completion_lost",
                "BTCC SQLite close ended without a completion result",
            )
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

fn run_connection_lane(
    path: &Path,
    profile: StorageProfile,
    activation: &StorageActivation,
    identity: RuntimeOwnerIdentity,
    liveness: Arc<dyn ProcessLiveness>,
    mut receiver: mpsc::Receiver<DatabaseOperation>,
    initialized: oneshot::Sender<StorageResult<(String, u64)>>,
) -> StorageResult<()> {
    let setup: StorageResult<(Connection, RuntimeOwner)> = (|| {
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent).map_err(|error| {
                StorageError::new("sqlite_parent_create_failed", error.to_string())
            })?;
        }
        let mut connection = Connection::open(path).map_err(StorageError::sqlite)?;
        configure(&connection, profile)?;
        validate_activation(&connection, activation)?;
        schema::create_current(&connection).map_err(StorageError::sqlite)?;
        migration::apply(&mut connection).map_err(StorageError::sqlite)?;
        legacy_cutover::apply(&mut connection)?;
        let owner = RuntimeOwner::register(&mut connection, identity, liveness)?;
        Ok((connection, owner))
    })();
    let (mut connection, owner) = match setup {
        Ok(value) => value,
        Err(error) => {
            let _ignored_closed_opener = initialized.send(Err(error.clone()));
            return Err(error);
        }
    };
    if initialized
        .send(Ok((owner.owner_id().to_owned(), owner.generation())))
        .is_err()
    {
        owner.close(&connection)?;
        return Ok(());
    }
    while let Some(operation) = receiver.blocking_recv() {
        operation(&mut connection, &owner);
    }
    owner.close(&connection)?;
    if !connection.is_autocommit() {
        return Err(StorageError::new(
            "sqlite_transaction_open_at_close",
            "BTCC database transaction remained open at close",
        ));
    }
    connection
        .close()
        .map_err(|(_, error)| StorageError::sqlite(error))
}

fn configure(connection: &Connection, profile: StorageProfile) -> StorageResult<()> {
    connection
        .busy_timeout(Duration::from_millis(5_000))
        .map_err(StorageError::sqlite)?;
    connection
        .pragma_update(
            None,
            "journal_mode",
            match profile {
                StorageProfile::Durable => "WAL",
                #[cfg(test)]
                StorageProfile::Ephemeral => "DELETE",
            },
        )
        .map_err(StorageError::sqlite)?;
    connection
        .pragma_update(None, "foreign_keys", "ON")
        .map_err(StorageError::sqlite)?;
    connection
        .pragma_update(None, "synchronous", "NORMAL")
        .map_err(StorageError::sqlite)
}

fn validate_activation(
    connection: &Connection,
    activation: &StorageActivation,
) -> StorageResult<()> {
    let receipt = storage_marker(
        connection,
        "agent_storage_migration_receipt",
        "receipt_json",
    )?
    .ok_or_else(|| StorageError::new("agent_btcc_storage_receipt_missing", "missing receipt"))?;
    let marker = storage_marker(connection, "agent_storage_activation_marker", "marker_json")?
        .ok_or_else(|| {
            StorageError::new("agent_btcc_storage_activation_missing", "missing marker")
        })?;
    let receipt_json = parse_marker(&receipt.1, "agent_btcc_storage_receipt_invalid")?;
    let marker_json = parse_marker(&marker.1, "agent_btcc_storage_activation_invalid")?;
    let valid = receipt.0 == activation.manifest_id
        && marker.0 == activation.manifest_id
        && receipt_json.get("manifestId").and_then(Value::as_str)
            == Some(activation.manifest_id.as_str())
        && receipt_json.get("schema").and_then(Value::as_str)
            == Some("butler.agent-btcc-storage-migration.v1")
        && marker_json.get("manifestId").and_then(Value::as_str)
            == Some(activation.manifest_id.as_str())
        && marker_json.get("schema").and_then(Value::as_str)
            == Some("butler.agent-btcc-storage-activation.v1")
        && marker_json.get("storageContract").and_then(Value::as_str) == Some("split-v1")
        && marker_json
            .get("firstActivatedAt")
            .and_then(Value::as_str)
            .is_some_and(|v| !v.is_empty())
        && marker_json
            .get("activatedAt")
            .and_then(Value::as_str)
            .is_some_and(|v| !v.is_empty());
    if !valid {
        return Err(StorageError::new(
            "agent_btcc_storage_activation_invalid",
            "BTCC split activation does not match its validated migration receipt",
        ));
    }
    Ok(())
}

fn storage_marker(
    connection: &Connection,
    table: &str,
    json_column: &str,
) -> StorageResult<Option<(String, String)>> {
    let exists = connection
        .query_row(
            "SELECT 1 FROM sqlite_schema WHERE type = 'table' AND name = ?1",
            [table],
            |_| Ok(()),
        )
        .optional()
        .map_err(StorageError::sqlite)?
        .is_some();
    if !exists {
        return Ok(None);
    }
    connection
        .query_row(
            &format!("SELECT manifest_id, {json_column} FROM {table} WHERE singleton = 1"),
            [],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .optional()
        .map_err(StorageError::sqlite)
}

fn parse_marker(value: &str, code: &'static str) -> StorageResult<Value> {
    serde_json::from_str(value).map_err(|error| StorageError::new(code, error.to_string()))
}

async fn join_failed_initialization(thread: JoinHandle<StorageResult<()>>) {
    let _ignored_initialization_result = tokio::task::spawn_blocking(move || thread.join()).await;
}

#[cfg(test)]
mod guided_budget_tests;
#[cfg(test)]
mod progress_tests;
#[cfg(test)]
mod readiness_tests;
#[cfg(test)]
mod repository_tests;
#[cfg(test)]
pub(crate) mod tests;
#[cfg(test)]
pub(crate) use tests::Fixture as TestStorageFixture;
#[cfg(test)]
pub(crate) mod transition_tests;
#[cfg(test)]
pub(crate) use transition_tests::prepared as test_prepared_turn;
