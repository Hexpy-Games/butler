//! Bounded, read-only WAL connections; SQLite never runs on a Tokio worker.
use super::{AppStorageError, StorageResult};
use parking_lot::Mutex;
use rusqlite::{Connection, OpenFlags};
use std::{
    path::{Path, PathBuf},
    sync::{
        Arc,
        atomic::{AtomicBool, Ordering},
    },
    time::{Duration, Instant},
};
use tokio::sync::Semaphore;

// Two readers bound aggregate page-cache memory while writes remain independent.
const CONNECTIONS: usize = 2;

type ReadOperation = Box<dyn FnOnce(&Connection) -> StorageResult<()> + Send>;

struct CachedReader {
    connection: Connection,
    last_used: Instant,
}
const SPARE_RETENTION: Duration = Duration::from_secs(10);

pub(super) struct ReadPool {
    path: PathBuf,
    available: Mutex<Vec<CachedReader>>,
    permits: Arc<Semaphore>,
    gate: Arc<tokio::sync::RwLock<()>>,
    retiring: AtomicBool,
}
impl ReadPool {
    pub(super) fn open(path: &Path) -> StorageResult<Self> {
        let mut available = Vec::with_capacity(CONNECTIONS);
        // Validate one reader now; opening an unused spare retains its schema.
        available.push(CachedReader {
            connection: Self::connection(path)?,
            last_used: Instant::now(),
        });
        Ok(Self {
            path: path.to_owned(),
            available: Mutex::new(available),
            permits: Arc::new(Semaphore::new(CONNECTIONS)),
            gate: Arc::default(),
            retiring: AtomicBool::new(false),
        })
    }
    fn connection(path: &Path) -> StorageResult<Connection> {
        let connection =
            butler_platform::sqlite::open_with_flags(path, OpenFlags::SQLITE_OPEN_READ_ONLY)
                .map_err(AppStorageError::sqlite)?;
        super::tuning::configure_read(&connection)?;
        Ok(connection)
    }
    pub(super) fn read<T, F>(
        self: &Arc<Self>,
        operation: F,
    ) -> impl std::future::Future<Output = StorageResult<T>> + Send + '_
    where
        T: Send + 'static,
        F: FnOnce(&Connection) -> StorageResult<T> + Send + 'static,
    {
        let (sender, receiver) = tokio::sync::oneshot::channel();
        let operation: ReadOperation = Box::new(move |db| {
            let value = operation(db)?;
            let _sent = sender.send(value);
            Ok(())
        });
        self.complete(operation, receiver)
    }
    async fn complete<T: Send + 'static>(
        self: &Arc<Self>,
        operation: ReadOperation,
        receiver: tokio::sync::oneshot::Receiver<T>,
    ) -> StorageResult<T> {
        self.dispatch(operation).await?;
        receiver.await.map_err(|error| {
            AppStorageError::new(
                super::AppStorageCode::AppSqliteJoinFailed,
                error.to_string(),
            )
        })
    }
    // Erase the query type before the async/blocking boundary. Every query shares
    // one admission, transaction and panic-isolation implementation.
    async fn dispatch(self: &Arc<Self>, operation: ReadOperation) -> StorageResult<()> {
        let guard = self.gate.clone().read_owned().await;
        let permit = self
            .permits
            .clone()
            .acquire_owned()
            .await
            .map_err(|error| {
                AppStorageError::new(
                    super::AppStorageCode::AppSqliteOwnerClosed,
                    error.to_string(),
                )
            })?;
        let pool = self.clone();
        tokio::task::spawn_blocking(move || {
            let cached = pool.available.lock().pop();
            let connection = match cached {
                Some(reader) => reader.connection,
                None => Self::connection(&pool.path)?,
            };
            let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
                let transaction = connection
                    .unchecked_transaction()
                    .map_err(AppStorageError::sqlite)?;
                operation(&transaction)?;
                transaction.commit().map_err(AppStorageError::sqlite)?;
                Ok(())
            }));
            // Returning a reader starts one change-driven retirement task. It
            // also runs when the pool goes completely quiet after a burst.
            let mut readers = pool.available.lock();
            readers.retain(|reader| reader.last_used.elapsed() < SPARE_RETENTION);
            readers.push(CachedReader {
                connection,
                last_used: Instant::now(),
            });
            drop(readers);
            pool.schedule_retirement();
            drop(permit);
            drop(guard);
            match result {
                Ok(result) => result,
                Err(payload) => std::panic::resume_unwind(payload),
            }
        })
        .await
        .map_err(|error| {
            AppStorageError::new(
                super::AppStorageCode::AppSqliteJoinFailed,
                error.to_string(),
            )
        })?
    }
    fn schedule_retirement(self: &Arc<Self>) {
        if self.retiring.swap(true, Ordering::AcqRel) {
            return;
        }
        let pool = Arc::downgrade(self);
        tokio::spawn(async move {
            let mut wait = SPARE_RETENTION;
            loop {
                tokio::time::sleep(wait).await;
                let Some(pool) = pool.upgrade() else { break };
                let next = tokio::task::spawn_blocking(move || {
                    let mut readers = pool.available.lock();
                    if pool.permits.is_closed() {
                        return None;
                    }
                    readers.retain(|reader| reader.last_used.elapsed() < SPARE_RETENTION);
                    let next = readers
                        .iter()
                        .map(|reader| SPARE_RETENTION.saturating_sub(reader.last_used.elapsed()))
                        .min();
                    if next.is_none() {
                        // Clear under the same lock used when returning readers:
                        // a subsequent return will start a new retirement task.
                        pool.retiring.store(false, Ordering::Release);
                    }
                    next
                })
                .await;
                match next {
                    Ok(Some(next)) => wait = next,
                    _ => break,
                }
            }
        });
    }
    pub(super) async fn close(self: &Arc<Self>) {
        let _guard = self.gate.write().await;
        self.permits.close();
        let pool = self.clone();
        let _closed = tokio::task::spawn_blocking(move || pool.available.lock().clear()).await;
    }
}
