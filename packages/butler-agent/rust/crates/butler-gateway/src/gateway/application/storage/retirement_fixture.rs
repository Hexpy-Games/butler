//! Existing filesystem fault/hold seams, compiled only for fixture agents.
use super::{AppStorageCode, AppStorageError, DatabaseOperation, StorageResult};

pub(super) fn opening() -> StorageResult<()> {
    butler_platform::secure_fs::fault_checkpoint("app_sqlite_open").map_err(|error| {
        AppStorageError::new(AppStorageCode::AppSqliteError, error.to_string()).with_source(error)
    })
}

pub(super) fn hold(receiver: &tokio::sync::mpsc::Receiver<DatabaseOperation>) {
    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(30);
    let _released = butler_platform::secure_fs::hold_point("app_sqlite_retire", || {
        receiver.is_closed() || std::time::Instant::now() >= deadline
    });
}

/// Exercise the owner after the runtime which opened it has been destroyed.
pub(in crate::gateway::application) fn runtime_shutdown(
    path: std::path::PathBuf,
) -> StorageResult<()> {
    let runtime = tokio::runtime::Runtime::new().map_err(io_error)?;
    let storage = runtime.block_on(super::AppStorage::open(path, None, "now".into()))?;
    runtime.block_on(storage.execute(|db| {
        db.pragma_update(None, "user_version", 42)
            .map_err(AppStorageError::sqlite)
    }))?;
    drop(runtime);
    let closer = tokio::runtime::Runtime::new().map_err(io_error)?;
    closer.block_on(storage.close())
}

fn io_error(error: std::io::Error) -> AppStorageError {
    AppStorageError::new(AppStorageCode::AppSqliteJoinFailed, error.to_string()).with_source(error)
}
