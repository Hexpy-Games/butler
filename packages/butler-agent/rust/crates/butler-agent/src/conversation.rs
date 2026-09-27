//! Canonical Conversation SQLite owner and domain store.

mod admission;
mod codec;
mod error;
mod historical_origin;
mod historical_recovery;
mod messages;
mod schema;
mod sessions;
mod source;
mod summaries;
mod text_projection;
mod turn_outcome;
mod turns;
mod types;

pub(crate) use admission::{
    AdmissionEventVisibility, AdmissionMetric, AdmissionSource, CompletionMetric,
    CompletionObservation, ConversationAdmissionObserver, ConversationAdmissionTurn,
    ConversationAdmissionTurnInput, ConversationEnvelope, ConversationObserverFuture,
    ConversationOriginFacts, DurableSessionBinding, RuntimeAdmissionEvent,
    classify_conversation_origin, conversation_session_id_for_durable_session,
};
pub(crate) use error::{ConversationCode, ConversationError};
pub(crate) use historical_origin::classify_historical_origins;
pub(crate) use historical_recovery::{
    HistoricalRecoveryInput, plan_historical_recovery, read_historical_app_rows,
    read_historical_transcript_rows,
};
pub(crate) use source::{
    CanonicalMemoryReadBinding, ConversationScalar, ConversationSourceReader, PublicMemoryScope,
    PublicMemorySnapshot, PublicSessionRow, RecallOutcomeRow, decode_message_scalars,
    scalar_for_part,
};
pub(crate) use text_projection::{text_for_message, text_for_part};
pub(crate) use types::*;

use std::cmp::Ordering;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::thread::JoinHandle;
use std::time::Duration;

use rusqlite::Connection;
use tokio::sync::{Mutex as AsyncMutex, mpsc, oneshot};

const OPERATION_QUEUE_CAPACITY: usize = 64;

pub(crate) fn conversation_store_path(butler_data: &Path) -> PathBuf {
    butler_data.join("runtime/conversation-store.sqlite")
}

type ConversationResult<T> = Result<T, ConversationError>;
type DatabaseOperation = Box<dyn FnOnce(&mut Connection) + Send + 'static>;

pub(crate) trait ConversationIdentityClock: Send + Sync {
    fn id(&self, prefix: &'static str) -> String;
    fn now_iso(&self) -> String;
}

pub(crate) trait ConversationLocaleCollation: Send + Sync {
    fn compare(&self, left: &str, right: &str) -> Ordering;
}

impl ConversationLocaleCollation for crate::locale::LocaleCollation {
    fn compare(&self, left: &str, right: &str) -> Ordering {
        crate::locale::LocaleCollation::compare(self, left, right)
    }
}

pub(crate) struct ConversationStoreConfig {
    pub(crate) path: PathBuf,
    pub(crate) identity_clock: Arc<dyn ConversationIdentityClock>,
    pub(crate) collation: Arc<dyn ConversationLocaleCollation>,
}

#[derive(Clone)]
pub(crate) struct AgentConversationStore {
    inner: Arc<StoreInner>,
}

struct StoreInner {
    lane: AsyncMutex<LaneState>,
    identity_clock: Arc<dyn ConversationIdentityClock>,
    collation: Arc<dyn ConversationLocaleCollation>,
}

struct LaneState {
    sender: Option<mpsc::Sender<DatabaseOperation>>,
    thread: Option<JoinHandle<ConversationResult<()>>>,
    close_result: Option<ConversationResult<()>>,
    close_waiters: Vec<oneshot::Sender<ConversationResult<()>>>,
}

impl AgentConversationStore {
    pub(crate) async fn open(config: ConversationStoreConfig) -> ConversationResult<Self> {
        let (sender, receiver) = mpsc::channel(OPERATION_QUEUE_CAPACITY);
        let (initialized_tx, initialized_rx) = oneshot::channel();
        let path = config.path;
        let lane_clock = Arc::clone(&config.identity_clock);
        let thread = std::thread::Builder::new()
            .name("butler-conversation-sqlite".to_owned())
            .spawn(move || run_connection_lane(path, &lane_clock, receiver, initialized_tx))
            .map_err(|error| {
                ConversationError::new(
                    ConversationCode::ConversationThreadSpawnFailed,
                    error.to_string(),
                )
                .with_source(error)
            })?;
        match initialized_rx.await {
            Ok(Ok(())) => Ok(Self {
                inner: Arc::new(StoreInner {
                    lane: AsyncMutex::new(LaneState {
                        sender: Some(sender),
                        thread: Some(thread),
                        close_result: None,
                        close_waiters: Vec::new(),
                    }),
                    identity_clock: config.identity_clock,
                    collation: config.collation,
                }),
            }),
            Ok(Err(error)) => {
                join_failed_initialization(thread).await;
                Err(error)
            }
            Err(_) => {
                join_failed_initialization(thread).await;
                Err(ConversationError::new(
                    ConversationCode::ConversationInitializationLost,
                    "Conversation SQLite owner exited before initialization completed",
                ))
            }
        }
    }

    pub(crate) fn identity_clock(&self) -> &Arc<dyn ConversationIdentityClock> {
        &self.inner.identity_clock
    }

    pub(crate) fn collation(&self) -> &Arc<dyn ConversationLocaleCollation> {
        &self.inner.collation
    }

    async fn execute<T, F>(&self, operation: F) -> ConversationResult<T>
    where
        T: Send + 'static,
        F: FnOnce(&mut Connection) -> ConversationResult<T> + Send + 'static,
    {
        let (completion_tx, completion_rx) = oneshot::channel();
        let job: DatabaseOperation = Box::new(move |connection| {
            let _ignored_cancelled_caller = completion_tx.send(operation(connection));
        });
        let lane = self.inner.lane.lock().await;
        let sender = lane.sender.as_ref().ok_or_else(|| {
            ConversationError::new(
                ConversationCode::ConversationClosed,
                "Conversation store is closing",
            )
        })?;
        let permit = sender.reserve().await.map_err(|source| {
            ConversationError::new(
                ConversationCode::ConversationClosed,
                "Conversation execution lane closed",
            )
            .with_source(source)
        })?;
        permit.send(job);
        drop(lane);
        completion_rx.await.map_err(|source| {
            ConversationError::new(
                ConversationCode::ConversationCompletionLost,
                "Conversation operation ended without completion",
            )
            .with_source(source)
        })?
    }

    pub(crate) async fn close(&self) -> ConversationResult<()> {
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
            let error = ConversationError::new(
                ConversationCode::ConversationThreadMissing,
                "Conversation SQLite owner thread is unavailable",
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
                let result = tokio::task::spawn_blocking(move || thread.join())
                    .await
                    .map_err(|error| {
                        ConversationError::new(
                            ConversationCode::ConversationJoinFailed,
                            error.to_string(),
                        )
                        .with_source(error)
                    })
                    .and_then(|joined| {
                        // A panic payload is not an Error; the code records the panic.
                        joined.map_err(|_panic_payload| {
                            ConversationError::new(
                                ConversationCode::ConversationThreadPanicked,
                                "Conversation SQLite owner thread panicked",
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
        waiter_rx.await.map_err(|source| {
            ConversationError::new(
                ConversationCode::ConversationCloseCompletionLost,
                "Conversation close ended without completion",
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
    clock: &Arc<dyn ConversationIdentityClock>,
    mut receiver: mpsc::Receiver<DatabaseOperation>,
    initialized: oneshot::Sender<ConversationResult<()>>,
) -> ConversationResult<()> {
    let setup: ConversationResult<Connection> = (|| {
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent).map_err(|error| {
                ConversationError::new(
                    ConversationCode::ConversationParentCreateFailed,
                    error.to_string(),
                )
                .with_source(error)
            })?;
        }
        let connection = Connection::open(path).map_err(ConversationError::sqlite)?;
        connection
            .busy_timeout(Duration::ZERO)
            .map_err(ConversationError::sqlite)?;
        connection
            .pragma_update(None, "journal_mode", "WAL")
            .map_err(ConversationError::sqlite)?;
        connection
            .pragma_update(None, "synchronous", "NORMAL")
            .map_err(ConversationError::sqlite)?;
        connection
            .pragma_update(None, "foreign_keys", "ON")
            .map_err(ConversationError::sqlite)?;
        schema::ensure(&connection, clock.as_ref())?;
        Ok(connection)
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
        return Err(ConversationError::new(
            ConversationCode::ConversationTransactionOpenAtClose,
            "Conversation transaction remained open at close",
        ));
    }
    connection
        .close()
        .map_err(|(_, error)| ConversationError::sqlite(error))
}

async fn join_failed_initialization(thread: JoinHandle<ConversationResult<()>>) {
    let _ignored_initialization_result = tokio::task::spawn_blocking(move || thread.join()).await;
}

#[cfg(test)]
mod tests;
