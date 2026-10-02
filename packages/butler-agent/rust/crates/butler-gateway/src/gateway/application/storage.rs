//! Single-owner SQLite lane for the App database.

mod cached;
mod error;
mod lane;
pub(super) mod metrics;
mod operation;
mod read_pool;
mod schema;
mod tuning;

use butler_platform::sqlite;
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
type Completion = Box<dyn FnOnce(StorageResult<()>) + Send>;
type DatabaseOperation = lane::Operation;

#[derive(Clone)]
pub(super) struct AppStorage {
    inner: Arc<StorageInner>,
    inspect: bool,
    barrier: bool,
}

struct StorageInner {
    lane: Mutex<LaneState>,
    readers: Arc<read_pool::ReadPool>,
    metrics: Arc<metrics::Metrics>,
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
        let read_path = path.clone();
        let metrics = Arc::new(metrics::Metrics::default());
        let lane_metrics = metrics.clone();
        let thread = std::thread::Builder::new()
            .name("butler-app-sqlite".to_owned())
            .spawn(move || {
                run_connection_lane(
                    &path,
                    butler_data.as_ref(),
                    &initialized_at,
                    receiver,
                    initialized_tx,
                    &lane_metrics,
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
                let readers = match open_readers(read_path).await {
                    Ok(readers) => readers,
                    Err(error) => {
                        drop(sender);
                        join_failed_initialization(thread).await;
                        return Err(error);
                    }
                };
                let inner = Arc::new(StorageInner {
                    readers: Arc::new(readers),
                    metrics,
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
                Ok(Self {
                    inner,
                    inspect: false,
                    barrier: false,
                })
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
        let job = operation::job(
            operation,
            completion_tx,
            self.inner.metrics.clone(),
            self.inspect,
            self.barrier,
        );
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

    pub(super) async fn inspect<T, F>(&self, operation: F) -> StorageResult<T>
    where
        T: Send + 'static,
        F: FnOnce(&mut Connection) -> StorageResult<T> + Send + 'static,
    {
        Self {
            inner: self.inner.clone(),
            inspect: true,
            barrier: false,
        }
        .execute(operation)
        .await
    }

    pub(super) async fn exclusive<T, F>(&self, operation: F) -> StorageResult<T>
    where
        T: Send + 'static,
        F: FnOnce(&mut Connection) -> StorageResult<T> + Send + 'static,
    {
        Self {
            inner: self.inner.clone(),
            inspect: true,
            barrier: true,
        }
        .execute(operation)
        .await
    }

    pub(super) async fn read<T, F>(&self, operation: F) -> StorageResult<T>
    where
        T: Send + 'static,
        F: FnOnce(&Connection) -> StorageResult<T> + Send + 'static,
    {
        if metrics::baseline() {
            return self.execute(move |db| operation(db)).await;
        }
        let result = self.inner.readers.read(operation).await;
        if result.as_ref().is_err_and(AppStorageError::is_busy) {
            self.inner.metrics.busy();
        }
        result
    }

    /// Copies available WAL pages without waiting for foreground readers.
    pub(super) async fn checkpoint(&self) -> StorageResult<()> {
        self.exclusive(|connection| tuning::passive_checkpoint(connection))
            .await
    }

    pub(super) async fn close(&self) -> StorageResult<()> {
        self.inner.readers.close().await;
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
    path: &std::path::Path,
    butler_data: Option<&PathBuf>,
    initialized_at: &str,
    receiver: mpsc::Receiver<DatabaseOperation>,
    initialized: oneshot::Sender<StorageResult<()>>,
    metrics: &Arc<metrics::Metrics>,
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
        let mut connection = sqlite::open(path).map_err(AppStorageError::sqlite)?;
        tuning::configure(&connection)?;
        schema::migrate(&mut connection, butler_data.map(PathBuf::as_path))?;
        schema::seed(&connection, initialized_at)?;
        schema::migrate_legacy_schedules(&mut connection, butler_data.map(PathBuf::as_path))?;
        tuning::analyze_at_open(&connection)?;
        super::monitoring::materialized::refresh(&connection)?;
        // Recovery and startup seeding precede normal runtime checkpoints.
        connection
            .pragma_update(None, "wal_autocheckpoint", 1000)
            .map_err(AppStorageError::sqlite)?;
        event_outbox::install(&connection, metrics.clone());
        metrics::configure(&connection)?;
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
    lane::run(&mut connection, receiver)?;
    metrics.save(path)?;
    close_connection(connection)
}

fn close_connection(connection: Connection) -> StorageResult<()> {
    if !connection.is_autocommit() {
        return Err(AppStorageError::new(
            AppStorageCode::AppSqliteTransactionOpenAtClose,
            "App SQLite transaction remained open at close",
        ));
    }
    tuning::prepare_close(&connection)?;
    crate::gateway::shutdown_trace::measure_sync("app_sqlite_connection_close", || {
        connection.close()
    })
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
                let storage = AppStorage {
                    inner,
                    inspect: true,
                    barrier: false,
                };
                if storage
                    .exclusive(|connection| tuning::optimize(connection))
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

async fn open_readers(path: PathBuf) -> StorageResult<read_pool::ReadPool> {
    tokio::task::spawn_blocking(move || read_pool::ReadPool::open(&path))
        .await
        .map_err(|error| {
            AppStorageError::new(AppStorageCode::AppSqliteJoinFailed, error.to_string())
        })?
}
