//! Bounded, read-only WAL connections; SQLite never runs on a Tokio worker.
use super::{StorageError, StorageResult};
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

const CONNECTIONS: usize = 2;
// Keep the entire pool's page caches within 1 MiB, leaving room for schemas.
const PAGE_CACHE_KIB: &str = "-512";

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
                .map_err(StorageError::sqlite)?;
        connection
            .busy_timeout(std::time::Duration::from_secs(5))
            .map_err(StorageError::sqlite)?;
        for (name, value) in [
            ("query_only", "ON"),
            ("cache_size", PAGE_CACHE_KIB),
            ("mmap_size", "0"),
            ("temp_store", "MEMORY"),
        ] {
            connection
                .pragma_update(None, name, value)
                .map_err(StorageError::sqlite)?;
        }
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
            StorageError::new(
                super::StorageCode::SqliteOperationCompletionLost,
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
                StorageError::new(super::StorageCode::SqliteOwnerClosed, error.to_string())
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
                    .map_err(StorageError::sqlite)?;
                operation(&transaction)?;
                transaction.commit().map_err(StorageError::sqlite)?;
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
            StorageError::new(
                super::StorageCode::SqliteOperationCompletionLost,
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
    #[cfg(test)]
    pub(super) async fn assert_quiet_retirement(self: &Arc<Self>) {
        self.read(|_| Ok(())).await.expect("start retirement");
        tokio::time::sleep(SPARE_RETENTION + Duration::from_secs(1)).await;
        assert!(
            self.available.lock().is_empty(),
            "quiet readers must retire"
        );
    }
    pub(super) async fn close(self: &Arc<Self>) {
        let _guard = self.gate.write().await;
        self.permits.close();
        let pool = self.clone();
        let _closed = tokio::task::spawn_blocking(move || pool.available.lock().clear()).await;
    }
}

pub(super) async fn open(
    path: std::path::PathBuf,
    profile: super::StorageProfile,
) -> StorageResult<Option<Arc<ReadPool>>> {
    if !matches!(profile, super::StorageProfile::Durable) {
        return Ok(None);
    }
    tokio::task::spawn_blocking(move || ReadPool::open(&path).map(|pool| Some(Arc::new(pool))))
        .await
        .map_err(|error| {
            StorageError::new(
                super::StorageCode::SqliteOperationCompletionLost,
                error.to_string(),
            )
        })?
}
impl super::BtccStorage {
    pub(super) async fn read<T, F>(&self, operation: F) -> StorageResult<T>
    where
        T: Send + 'static,
        F: FnOnce(&Connection) -> StorageResult<T> + Send + 'static,
    {
        if matches!(
            std::env::var("BUTLER_E2E_TIER").as_deref(),
            Ok("stub" | "perf")
        ) && std::env::var_os("BUTLER_E2E_STORAGE_BASELINE").is_some()
        {
            return self.execute(move |db| operation(db)).await;
        }
        match &self.inner.readers {
            Some(pool) => pool.read(operation).await,
            None => self.execute(move |db| operation(db)).await,
        }
    }
}
