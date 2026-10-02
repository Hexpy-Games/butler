//! Bounded, read-only WAL connections; SQLite never runs on a Tokio worker.
use super::{StorageError, StorageResult};
use parking_lot::Mutex;
use rusqlite::{Connection, OpenFlags};
use std::{path::Path, sync::Arc};
use tokio::sync::Semaphore;

const CONNECTIONS: usize = 2;
// Keep the entire pool's page caches within 8 MiB.
const PAGE_CACHE_KIB: &str = "-4096";

pub(super) struct ReadPool {
    available: Mutex<Vec<Connection>>,
    permits: Arc<Semaphore>,
    gate: Arc<tokio::sync::RwLock<()>>,
}
impl ReadPool {
    pub(super) fn open(path: &Path) -> StorageResult<Self> {
        let mut available = Vec::with_capacity(CONNECTIONS);
        for _ in 0..CONNECTIONS {
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
            available.push(connection);
        }
        Ok(Self {
            available: Mutex::new(available),
            permits: Arc::new(Semaphore::new(CONNECTIONS)),
            gate: Arc::default(),
        })
    }
    pub(super) async fn read<T, F>(self: &Arc<Self>, operation: F) -> StorageResult<T>
    where
        T: Send + 'static,
        F: FnOnce(&Connection) -> StorageResult<T> + Send + 'static,
    {
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
            let connection = pool.available.lock().pop().ok_or_else(|| {
                StorageError::new(super::StorageCode::SqliteOwnerClosed, "read pool closed")
            })?;
            let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
                let transaction = connection
                    .unchecked_transaction()
                    .map_err(StorageError::sqlite)?;
                let value = operation(&transaction)?;
                transaction.commit().map_err(StorageError::sqlite)?;
                Ok(value)
            }));
            pool.available.lock().push(connection);
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
