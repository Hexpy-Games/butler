//! Write completion notifications from the single SQLite owner.
use super::{
    BtccStorage, DatabaseOperation, RuntimeOwner, StorageCode, StorageError, StorageResult,
};
use rusqlite::Connection;
use tokio::sync::oneshot;

impl BtccStorage {
    /// Coalesced changes from completed write operations; reads never wake subscribers.
    pub fn subscribe_changes(&self) -> tokio::sync::watch::Receiver<()> {
        self.inner.changes.subscribe()
    }

    pub(super) fn execute_with_owner<T, F>(
        &self,
        operation: F,
    ) -> impl std::future::Future<Output = StorageResult<T>> + Send + '_
    where
        T: Send + 'static,
        F: FnOnce(&mut Connection, &RuntimeOwner) -> StorageResult<T> + Send + 'static,
    {
        let (completion_tx, completion_rx) = oneshot::channel();
        let changes = self.inner.changes.clone();
        let job: DatabaseOperation = Box::new(move |connection, owner| {
            let before = connection.total_changes();
            let result = operation(connection, owner);
            let synced = if connection.total_changes() == before {
                Ok(())
            } else {
                butler_platform::sqlite::sync_wal_index(connection).map_err(|error| {
                    StorageError::new(StorageCode::SqliteWalSyncFailed, error.to_string())
                        .with_source(error)
                })
            };
            if connection.total_changes() != before {
                changes.send_replace(());
            }
            let _ignored_cancelled_caller =
                completion_tx.send(result.and_then(|value| synced.map(|()| value)));
        });
        self.complete(job, completion_rx)
    }
}
