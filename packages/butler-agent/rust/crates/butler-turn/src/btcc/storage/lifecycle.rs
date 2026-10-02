//! Join the SQLite owner off Tokio workers, including failed initialization.
use super::{BtccStorage, DatabaseOperation, StorageCode, StorageError, StorageResult};
use std::thread::JoinHandle;

/// Joins the SQLite owner thread off the async runtime; a panic is reported
/// with its own code (the payload is not an error).
pub(super) async fn join_owner_thread(thread: JoinHandle<StorageResult<()>>) -> StorageResult<()> {
    let joined = tokio::task::spawn_blocking(move || thread.join())
        .await
        .map_err(|error| {
            StorageError::new(StorageCode::SqliteJoinFailed, error.to_string()).with_source(error)
        })?;
    joined.map_err(|_panic_payload| {
        StorageError::new(
            StorageCode::SqliteThreadPanicked,
            "BTCC SQLite owner thread panicked",
        )
    })?
}

pub(super) async fn join_failed_initialization(thread: JoinHandle<StorageResult<()>>) {
    let _ignored_initialization_result = tokio::task::spawn_blocking(move || thread.join()).await;
}

impl BtccStorage {
    // Queue reservation and close ordering do not depend on the query or result
    // type. Share this state machine instead of compiling it for every SQL job.
    pub(super) async fn admit(&self, job: DatabaseOperation) -> StorageResult<()> {
        let lane = self.inner.lane.lock().await;
        let sender = lane.sender.as_ref().ok_or_else(|| {
            StorageError::new(
                StorageCode::SqliteOwnerClosed,
                "BTCC SQLite owner is closing or closed",
            )
        })?;
        let permit = sender.reserve().await.map_err(|source| {
            StorageError::new(
                StorageCode::SqliteOwnerClosed,
                "BTCC SQLite execution lane has closed",
            )
            .with_source(source)
        })?;
        permit.send(job);
        drop(lane);
        Ok(())
    }
}
