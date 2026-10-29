//! Canon port. SQL runs only on the BTCC writer/read lanes.
use super::{BtccRepositories, BtccStorage, StorageError, StorageResult};
use butler_canon::store;
use rusqlite::{Connection, TransactionBehavior};
use store::Transaction;

impl BtccRepositories {
    /// Composition adapter over the same SQL lanes, outside Work transactions.
    pub fn canon_storage(&self) -> BtccStorage {
        self.storage.clone()
    }
}

impl BtccStorage {
    /// One domain operation (or batch), one IMMEDIATE transaction. Dropping the
    /// transaction rolls back domain rows, audit, counts, intents and outbox.
    /// `execute` provides the existing coalesced change notification.
    pub async fn canon_write<T, F>(&self, operation: F) -> StorageResult<T>
    where
        T: Send + 'static,
        F: FnOnce(&Transaction<'_>) -> store::Result<T> + Send + 'static,
    {
        self.execute(move |db| {
            let tx = db
                .transaction_with_behavior(TransactionBehavior::Immediate)
                .map_err(StorageError::sqlite)?;
            let tx = Transaction::new(tx).map_err(work_error)?;
            let value = operation(&tx).map_err(work_error)?;
            tx.commit().map_err(StorageError::sqlite)?;
            Ok(value)
        })
        .await
    }
    /// Read closures cannot write through the durable read pool's connections.
    pub async fn canon_read<T, F>(&self, operation: F) -> StorageResult<T>
    where
        T: Send + 'static,
        F: FnOnce(&Connection) -> store::Result<T> + Send + 'static,
    {
        // The pool owns the fresh WAL snapshot for the whole closure.
        self.read(move |db| operation(db).map_err(work_error)).await
    }
}
pub(super) fn work_error(error: store::Error) -> StorageError {
    if let store::Error::Sqlite(error) = error {
        return StorageError::sqlite(error);
    }
    let code = match &error {
        store::Error::Permission => "permission",
        store::Error::Running => "running",
        store::Error::Conflict { .. } => "conflict",
        store::Error::TagExists { .. } => "tag_exists",
        store::Error::NotFound => "work_model_not_found",
        store::Error::InvalidRank => "invalid_rank",
        store::Error::Invalid(_) | store::Error::Chain(_) => "work_model_invalid",
        store::Error::Json(_)
        | store::Error::BodyCodec(_)
        | store::Error::Id(_)
        | store::Error::Sqlite(_) => "work_model_internal",
    };
    // Preserve the typed error, including Conflict.current, for the API layer.
    StorageError::Port {
        code,
        message: error.to_string(),
        source: Some(std::sync::Arc::new(error)),
    }
}
