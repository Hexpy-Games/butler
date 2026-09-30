//! Single-owner SQLite lane for the App database.

mod cached;
mod error;
mod schema;
mod tuning;

pub(super) use cached::CachedSql;
pub(super) use error::{AppStorageCode, AppStorageError};
use std::{
    path::PathBuf,
    sync::{Arc, Weak},
    thread::JoinHandle,
    time::Duration,
};

use parking_lot::Mutex as SyncMutex;
use rusqlite::Connection;
use tokio::sync::{Mutex, mpsc, oneshot};

use super::event_outbox;

const OPERATION_QUEUE_CAPACITY: usize = 64;
/// Planner statistics are refreshed this often while the process runs.
const OPTIMIZE_INTERVAL: Duration = Duration::from_secs(6 * 60 * 60);
/// A refresh waits this long for the lane to go idle.
const OPTIMIZE_RETRY: Duration = Duration::from_secs(60);

type StorageResult<T> = Result<T, AppStorageError>;
type DatabaseOperation = Box<dyn FnOnce(&mut Connection) + Send + 'static>;

#[derive(Clone)]
pub(super) struct AppStorage {
    inner: Arc<StorageInner>,
}

struct StorageInner {
    lane: Mutex<LaneState>,
    optimizer: SyncMutex<Option<tokio::task::JoinHandle<()>>>,
}

struct LaneState {
    sender: Option<mpsc::Sender<DatabaseOperation>>,
    thread: Option<JoinHandle<StorageResult<()>>>,
    close_result: Option<StorageResult<()>>,
    close_waiters: Vec<oneshot::Sender<StorageResult<()>>>,
}

impl AppStorage {
    pub(super) async fn open(
        path: PathBuf,
        butler_data: Option<PathBuf>,
        initialized_at: String,
    ) -> StorageResult<Self> {
        let (sender, receiver) = mpsc::channel(OPERATION_QUEUE_CAPACITY);
        let (initialized_tx, initialized_rx) = oneshot::channel();
        let thread = std::thread::Builder::new()
            .name("butler-app-sqlite".to_owned())
            .spawn(move || {
                run_connection_lane(
                    path,
                    butler_data.as_ref(),
                    &initialized_at,
                    receiver,
                    initialized_tx,
                )
            })
            .map_err(|error| {
                AppStorageError::new(
                    AppStorageCode::AppSqliteThreadSpawnFailed,
                    error.to_string(),
                )
                .with_source(error)
            })?;
        match initialized_rx.await {
            Ok(Ok(())) => {
                let inner = Arc::new(StorageInner {
                    lane: Mutex::new(LaneState {
                        sender: Some(sender),
                        thread: Some(thread),
                        close_result: None,
                        close_waiters: Vec::new(),
                    }),
                    optimizer: SyncMutex::new(None),
                });
                *inner.optimizer.lock() =
                    Some(tokio::spawn(optimize_periodically(Arc::downgrade(&inner))));
                Ok(Self { inner })
            }
            Ok(Err(error)) => {
                join_failed_initialization(thread).await;
                Err(error)
            }
            Err(_) => {
                join_failed_initialization(thread).await;
                Err(AppStorageError::new(
                    AppStorageCode::AppSqliteInitializationChannelClosed,
                    "App SQLite owner exited before initialization completed",
                ))
            }
        }
    }

    pub(super) async fn execute<T, F>(&self, operation: F) -> StorageResult<T>
    where
        T: Send + 'static,
        F: FnOnce(&mut Connection) -> StorageResult<T> + Send + 'static,
    {
        let (completion_tx, completion_rx) = oneshot::channel();
        let job = Box::new(move |connection: &mut Connection| {
            let result = operation(connection);
            // Committed events reach subscribers before the caller sees the result.
            event_outbox::flush();
            let _cancelled_observer = completion_tx.send(result);
        });
        let lane = self.inner.lane.lock().await;
        let sender = lane.sender.as_ref().ok_or_else(|| {
            AppStorageError::new(
                AppStorageCode::AppSqliteOwnerClosed,
                "App SQLite owner is closing",
            )
        })?;
        let permit = sender.reserve().await.map_err(|source| {
            AppStorageError::new(
                AppStorageCode::AppSqliteOwnerClosed,
                "App SQLite lane has closed",
            )
            .with_source(source)
        })?;
        permit.send(job);
        drop(lane);
        completion_rx.await.map_err(|source| {
            AppStorageError::new(
                AppStorageCode::AppSqliteOperationCompletionLost,
                "App SQLite operation ended without a result",
            )
            .with_source(source)
        })?
    }

    /// Folds the WAL into the database file and truncates it.
    pub(super) async fn checkpoint(&self) -> StorageResult<()> {
        self.execute(|connection| tuning::checkpoint(connection))
            .await
    }

    pub(super) async fn close(&self) -> StorageResult<()> {
        if let Some(optimizer) = self.inner.optimizer.lock().take() {
            optimizer.abort();
        }
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
        lane.close_waiters.push(waiter_tx);
        drop(lane);
        if let Some(thread) = thread {
            let inner = Arc::clone(&self.inner);
            // Detached on purpose: close waiters receive the join result, and the join
            // must finish even when the caller that started closing is cancelled.
            tokio::spawn(async move {
                let result = join_owner(thread).await;
                let mut lane = inner.lane.lock().await;
                lane.close_result = Some(result.clone());
                let waiters = std::mem::take(&mut lane.close_waiters);
                drop(lane);
                for waiter in waiters {
                    let _cancelled_closer = waiter.send(result.clone());
                }
            });
        }
        waiter_rx.await.map_err(|source| {
            AppStorageError::new(
                AppStorageCode::AppSqliteCloseCompletionLost,
                "App SQLite close ended without a result",
            )
            .with_source(source)
        })?
    }
}

impl Drop for StorageInner {
    fn drop(&mut self) {
        if let Some(optimizer) = self.optimizer.lock().take() {
            optimizer.abort();
        }
        if let Ok(mut lane) = self.lane.try_lock() {
            lane.sender.take();
            lane.thread.take();
        }
    }
}

fn run_connection_lane(
    path: PathBuf,
    butler_data: Option<&PathBuf>,
    initialized_at: &str,
    mut receiver: mpsc::Receiver<DatabaseOperation>,
    initialized: oneshot::Sender<StorageResult<()>>,
) -> StorageResult<()> {
    let setup: StorageResult<Connection> = (|| {
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent).map_err(|error| {
                AppStorageError::new(
                    AppStorageCode::AppSqliteParentCreateFailed,
                    error.to_string(),
                )
                .with_source(error)
            })?;
        }
        let mut connection = Connection::open(path).map_err(AppStorageError::sqlite)?;
        tuning::configure(&connection)?;
        schema::migrate(&mut connection, butler_data.map(PathBuf::as_path))?;
        schema::seed(&connection, initialized_at)?;
        tuning::analyze_at_open(&connection)?;
        event_outbox::install(&connection);
        Ok(connection)
    })();
    let mut connection = match setup {
        Ok(connection) => connection,
        Err(error) => {
            let _closed_opener = initialized.send(Err(error.clone()));
            return Err(error);
        }
    };
    if initialized.send(Ok(())).is_err() {
        return close_connection(connection);
    }
    while let Some(operation) = receiver.blocking_recv() {
        operation(&mut connection);
    }
    // Statistics are an optimization: a failure must not fail the close.
    let _best_effort = tuning::optimize(&connection);
    tuning::checkpoint(&connection)?;
    close_connection(connection)
}

fn close_connection(connection: Connection) -> StorageResult<()> {
    if !connection.is_autocommit() {
        return Err(AppStorageError::new(
            AppStorageCode::AppSqliteTransactionOpenAtClose,
            "App SQLite transaction remained open at close",
        ));
    }
    connection
        .close()
        .map_err(|(_, error)| AppStorageError::sqlite(error))
}

async fn join_failed_initialization(thread: JoinHandle<StorageResult<()>>) {
    let _ignored = join_owner(thread).await;
}

async fn join_owner(thread: JoinHandle<StorageResult<()>>) -> StorageResult<()> {
    tokio::task::spawn_blocking(move || thread.join())
        .await
        .map_err(|error| {
            AppStorageError::new(AppStorageCode::AppSqliteJoinFailed, error.to_string())
                .with_source(error)
        })?
        .map_err(|_| {
            AppStorageError::new(
                AppStorageCode::AppSqliteThreadPanicked,
                "App SQLite owner panicked",
            )
        })?
}

/// Refreshes planner statistics every `OPTIMIZE_INTERVAL`, waiting for a moment
/// when no other operation is queued.
async fn optimize_periodically(inner: Weak<StorageInner>) {
    let mut interval = tokio::time::interval_at(
        tokio::time::Instant::now() + OPTIMIZE_INTERVAL,
        OPTIMIZE_INTERVAL,
    );
    loop {
        interval.tick().await;
        loop {
            let Some(inner) = inner.upgrade() else {
                return;
            };
            let idle = inner
                .lane
                .lock()
                .await
                .sender
                .as_ref()
                .is_some_and(|sender| sender.capacity() == OPERATION_QUEUE_CAPACITY);
            if idle {
                let storage = AppStorage { inner };
                if storage
                    .execute(|connection| tuning::optimize(connection))
                    .await
                    .is_err()
                {
                    return;
                }
                break;
            }
            drop(inner);
            tokio::time::sleep(OPTIMIZE_RETRY).await;
        }
    }
}
