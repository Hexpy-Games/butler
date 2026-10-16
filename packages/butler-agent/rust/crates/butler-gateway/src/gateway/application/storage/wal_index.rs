//! A read-completed connection retains SQLite's WAL-index and backfill state.
use super::{AppStorageCode, AppStorageError, StorageResult};
use butler_platform::sqlite;
use std::path::Path;

pub(super) fn open(path: &Path) -> StorageResult<sqlite::Connection> {
    // Allocate the holder separately from the startup writer. The connection
    // outlives this thread and every SQLite execution session.
    std::thread::scope(|scope| {
        std::thread::Builder::new()
            .name("app-wal-index".into())
            .spawn_scoped(scope, || {
                if let Some(parent) = path.parent() {
                    std::fs::create_dir_all(parent).map_err(|error| {
                        AppStorageError::new(AppStorageCode::AppSqliteParentCreateFailed, error.to_string())
                            .with_source(error)
                    })?;
                }
                let connection = sqlite::open(path).map_err(AppStorageError::sqlite)?;
                connection.set_prepared_statement_cache_capacity(0);
                connection.execute_batch(
                    "PRAGMA journal_mode=WAL; PRAGMA cache_size=1; PRAGMA mmap_size=0; PRAGMA user_version; PRAGMA shrink_memory; PRAGMA query_only=ON;"
                ).map_err(AppStorageError::sqlite)?;
                // user_version reads a database page without loading its schema.
                // No statement or transaction survives; checkpoints remain free.
                Ok(connection)
            })
            .map_err(|error| AppStorageError::new(AppStorageCode::AppSqliteThreadSpawnFailed, error.to_string()))?
            .join()
            .map_err(|_| AppStorageError::new(AppStorageCode::AppSqliteThreadPanicked, "WAL-index holder thread panicked"))?
    })
}
