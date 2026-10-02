//! Bounded, read-only WAL connections; SQLite never runs on a Tokio worker.
use super::{AppStorageError, StorageResult};
use parking_lot::Mutex;
use rusqlite::{Connection, OpenFlags};
use std::{path::Path, sync::Arc};
use tokio::sync::Semaphore;

// Two readers bound aggregate page-cache memory while writes remain independent.
const CONNECTIONS: usize = 2;

pub(super) struct ReadPool {
    available: Mutex<Vec<Connection>>,
    permits: Arc<Semaphore>,
    gate: Arc<tokio::sync::RwLock<()>>,
}
impl ReadPool {
    pub(super) fn open(path: &Path) -> StorageResult<Self> {
        let mut available = Vec::with_capacity(CONNECTIONS);
        for _ in 0..CONNECTIONS {
            let connection = Connection::open_with_flags(path, OpenFlags::SQLITE_OPEN_READ_ONLY)
                .map_err(AppStorageError::sqlite)?;
            super::tuning::configure_read(&connection)?;
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
                AppStorageError::new(
                    super::AppStorageCode::AppSqliteOwnerClosed,
                    error.to_string(),
                )
            })?;
        let pool = self.clone();
        tokio::task::spawn_blocking(move || {
            let connection = pool.available.lock().pop().ok_or_else(|| {
                AppStorageError::new(
                    super::AppStorageCode::AppSqliteOwnerClosed,
                    "read pool closed",
                )
            })?;
            let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
                let transaction = connection
                    .unchecked_transaction()
                    .map_err(AppStorageError::sqlite)?;
                let value = operation(&transaction)?;
                transaction.commit().map_err(AppStorageError::sqlite)?;
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
            AppStorageError::new(
                super::AppStorageCode::AppSqliteJoinFailed,
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
