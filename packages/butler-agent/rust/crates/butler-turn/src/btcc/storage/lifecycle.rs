//! Join the SQLite owner off Tokio workers, including failed initialization.
use super::{StorageCode, StorageError, StorageResult};
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
