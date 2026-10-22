//! Inert work-model port. SQL runs only on the BTCC writer/read lanes.
use super::{BtccStorage, StorageError, StorageResult};
use butler_work::store;
use rusqlite::{Connection, Transaction, TransactionBehavior};

impl BtccStorage {
    /// One domain operation (or batch), one IMMEDIATE transaction. Dropping the
    /// transaction rolls back domain rows, audit, counts, intents and outbox.
    /// `execute` provides the existing coalesced change notification.
    pub async fn work_model_write<T, F>(&self, operation: F) -> StorageResult<T>
    where
        T: Send + 'static,
        F: FnOnce(&Transaction<'_>) -> store::Result<T> + Send + 'static,
    {
        self.execute(move |db| {
            let tx = db
                .transaction_with_behavior(TransactionBehavior::Immediate)
                .map_err(StorageError::sqlite)?;
            let value = operation(&tx).map_err(work_error)?;
            tx.commit().map_err(StorageError::sqlite)?;
            Ok(value)
        })
        .await
    }
    /// Read closures cannot write through the durable read pool's connections.
    pub async fn work_model_read<T, F>(&self, operation: F) -> StorageResult<T>
    where
        T: Send + 'static,
        F: FnOnce(&Connection) -> store::Result<T> + Send + 'static,
    {
        // The pool owns the fresh WAL snapshot for the whole closure.
        self.read(move |db| operation(db).map_err(work_error)).await
    }
}
fn work_error(error: store::Error) -> StorageError {
    if let store::Error::Sqlite(error) = error {
        return StorageError::sqlite(error);
    }
    let code = match &error {
        store::Error::Conflict { .. } => "conflict",
        store::Error::Running => "running",
        store::Error::NotFound => "work_model_not_found",
        store::Error::InvalidRank => "invalid_rank",
        store::Error::ConversationOccupied => "conversation_occupied",
        store::Error::CrossChat => "cross_chat",
        _ => "work_model_invalid",
    };
    // Preserve the typed error, including Conflict.current, for the API layer.
    StorageError::Port {
        code,
        message: error.to_string(),
        source: Some(std::sync::Arc::new(error)),
    }
}
