//! Single-owner SQLite lane for the App database.

mod schema;

use std::{fmt, path::PathBuf, sync::Arc, thread::JoinHandle, time::Duration};

use rusqlite::Connection;
use tokio::sync::{Mutex, mpsc, oneshot};

const OPERATION_QUEUE_CAPACITY: usize = 64;

type StorageResult<T> = Result<T, AppStorageError>;
type DatabaseOperation = Box<dyn FnOnce(&mut Connection) + Send + 'static>;

#[derive(Clone, Debug, Eq, PartialEq)]
pub(super) struct AppStorageError {
    code: &'static str,
    detail: String,
}

impl AppStorageError {
    pub(super) fn new(code: &'static str, detail: impl Into<String>) -> Self {
        Self {
            code,
            detail: detail.into(),
        }
    }

    pub(super) fn sqlite(error: rusqlite::Error) -> Self {
        Self::new("app_sqlite_error", error.to_string())
    }

    pub(super) fn code(&self) -> &'static str {
        self.code
    }

    pub(super) fn detail(&self) -> &str {
        &self.detail
    }
}

impl fmt::Display for AppStorageError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(formatter, "{}: {}", self.code, self.detail)
    }
}

#[derive(Clone)]
pub(super) struct AppStorage {
    inner: Arc<StorageInner>,
}

struct StorageInner {
    lane: Mutex<LaneState>,
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
                run_connection_lane(path, butler_data, initialized_at, receiver, initialized_tx)
            })
            .map_err(|error| {
                AppStorageError::new("app_sqlite_thread_spawn_failed", error.to_string())
            })?;
        match initialized_rx.await {
            Ok(Ok(())) => Ok(Self {
                inner: Arc::new(StorageInner {
                    lane: Mutex::new(LaneState {
                        sender: Some(sender),
                        thread: Some(thread),
                        close_result: None,
                        close_waiters: Vec::new(),
                    }),
                }),
            }),
            Ok(Err(error)) => {
                join_failed_initialization(thread).await;
                Err(error)
            }
            Err(_) => {
                join_failed_initialization(thread).await;
                Err(AppStorageError::new(
                    "app_sqlite_initialization_channel_closed",
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
            let _cancelled_observer = completion_tx.send(operation(connection));
        });
        let lane = self.inner.lane.lock().await;
        let sender = lane.sender.as_ref().ok_or_else(|| {
            AppStorageError::new("app_sqlite_owner_closed", "App SQLite owner is closing")
        })?;
        let permit = sender.reserve().await.map_err(|_| {
            AppStorageError::new("app_sqlite_owner_closed", "App SQLite lane has closed")
        })?;
        permit.send(job);
        drop(lane);
        completion_rx.await.map_err(|_| {
            AppStorageError::new(
                "app_sqlite_operation_completion_lost",
                "App SQLite operation ended without a result",
            )
        })?
    }

    pub(super) async fn close(&self) -> StorageResult<()> {
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
        waiter_rx.await.map_err(|_| {
            AppStorageError::new(
                "app_sqlite_close_completion_lost",
                "App SQLite close ended without a result",
            )
        })?
    }
}

impl Drop for StorageInner {
    fn drop(&mut self) {
        if let Ok(mut lane) = self.lane.try_lock() {
            lane.sender.take();
            lane.thread.take();
        }
    }
}

fn run_connection_lane(
    path: PathBuf,
    butler_data: Option<PathBuf>,
    initialized_at: String,
    mut receiver: mpsc::Receiver<DatabaseOperation>,
    initialized: oneshot::Sender<StorageResult<()>>,
) -> StorageResult<()> {
    let setup: StorageResult<Connection> = (|| {
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent).map_err(|error| {
                AppStorageError::new("app_sqlite_parent_create_failed", error.to_string())
            })?;
        }
        let mut connection = Connection::open(path).map_err(AppStorageError::sqlite)?;
        configure(&connection)?;
        schema::migrate(&mut connection, butler_data.as_deref())?;
        schema::seed(&connection, &initialized_at)?;
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
    connection
        .execute_batch("PRAGMA wal_checkpoint(TRUNCATE)")
        .map_err(AppStorageError::sqlite)?;
    close_connection(connection)
}

fn configure(connection: &Connection) -> StorageResult<()> {
    connection
        .busy_timeout(Duration::from_millis(5_000))
        .map_err(AppStorageError::sqlite)?;
    connection
        .pragma_update(None, "journal_mode", "WAL")
        .map_err(AppStorageError::sqlite)?;
    connection
        .pragma_update(None, "foreign_keys", "ON")
        .map_err(AppStorageError::sqlite)?;
    connection
        .pragma_update(None, "synchronous", "NORMAL")
        .map_err(AppStorageError::sqlite)
}

fn close_connection(connection: Connection) -> StorageResult<()> {
    if !connection.is_autocommit() {
        return Err(AppStorageError::new(
            "app_sqlite_transaction_open_at_close",
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
        .map_err(|error| AppStorageError::new("app_sqlite_join_failed", error.to_string()))?
        .map_err(|_| {
            AppStorageError::new("app_sqlite_thread_panicked", "App SQLite owner panicked")
        })?
}
