//! Connection tuning for the App database: page cache, memory map, statement
//! cache, query-planner statistics and WAL size.

use std::time::Duration;

use rusqlite::{Connection, config::DbConfig};

use super::{AppStorageError, StorageResult};

/// Compiled statements the lane keeps for `prepare_cached`.
const CACHED_STATEMENTS: usize = 256;
/// Bound resident pages to 8 MiB; indexed foreground reads need no large cache.
const PAGE_CACHE_KIB: i64 = -8_192;
/// Two readers keep an aggregate 8 MiB cache, separate from the writer.
const READ_PAGE_CACHE_KIB: i64 = -4_096;
/// Startup sweeps otherwise leave mapped database pages resident indefinitely.
/// Use the bounded page cache for reads instead.
const MMAP_BYTES: i64 = 0;
/// Largest WAL file kept after a checkpoint: 64 MiB.
const WAL_LIMIT_BYTES: i64 = 67_108_864;
/// Rows sampled per index when `optimize` refreshes statistics.
const ANALYSIS_ROWS: i64 = 1_000;

pub(super) fn configure(connection: &Connection) -> StorageResult<()> {
    connection
        .busy_timeout(Duration::from_millis(5_000))
        .map_err(AppStorageError::sqlite)?;
    connection.set_prepared_statement_cache_capacity(CACHED_STATEMENTS);
    for (pragma, value) in [
        ("journal_mode", "WAL".to_owned()),
        ("wal_autocheckpoint", "0".to_owned()),
        ("foreign_keys", "ON".to_owned()),
        ("synchronous", "NORMAL".to_owned()),
        ("cache_size", PAGE_CACHE_KIB.to_string()),
        ("mmap_size", MMAP_BYTES.to_string()),
        ("temp_store", "MEMORY".to_owned()),
        ("journal_size_limit", WAL_LIMIT_BYTES.to_string()),
        ("analysis_limit", ANALYSIS_ROWS.to_string()),
    ] {
        connection
            .pragma_update(None, pragma, value)
            .map_err(AppStorageError::sqlite)?;
    }
    Ok(())
}

/// Statistics for every table, once per open (the planner has none for a
/// database that never ran them).
pub(super) fn analyze_at_open(connection: &Connection) -> StorageResult<()> {
    connection
        .execute_batch("PRAGMA optimize=0x10002")
        .map_err(AppStorageError::sqlite)
}

/// Refreshes the statistics of tables that changed a lot since the last run.
pub(super) fn optimize(connection: &Connection) -> StorageResult<()> {
    connection
        .execute_batch("PRAGMA optimize")
        .map_err(AppStorageError::sqlite)
}

/// Retention must never wait for foreground readers to release the WAL.
pub(super) fn passive_checkpoint(connection: &Connection) -> StorageResult<()> {
    connection
        .execute_batch("PRAGMA wal_checkpoint(PASSIVE)")
        .map_err(AppStorageError::sqlite)
}

pub(super) fn configure_read(connection: &Connection) -> StorageResult<()> {
    connection
        .busy_timeout(Duration::from_secs(5))
        .map_err(AppStorageError::sqlite)?;
    connection.set_prepared_statement_cache_capacity(CACHED_STATEMENTS);
    for (name, value) in [
        ("query_only", "ON".to_owned()),
        ("cache_size", READ_PAGE_CACHE_KIB.to_string()),
        ("mmap_size", MMAP_BYTES.to_string()),
        ("temp_store", "MEMORY".to_owned()),
    ] {
        connection
            .pragma_update(None, name, value)
            .map_err(AppStorageError::sqlite)?;
    }
    Ok(())
}

/// NORMAL commits need a WAL sync before a completed close promises durability.
/// Keep the WAL for recovery; checkpointing also writes and syncs the database.
pub(super) fn sync_wal(connection: &Connection) -> StorageResult<()> {
    let Some(path) = connection.path().filter(|path| !path.is_empty()) else {
        return Ok(());
    };
    let wal = std::path::PathBuf::from(format!("{path}-wal"));
    let result = crate::gateway::shutdown_trace::measure_sync("app_sqlite_wal_fsync", || {
        butler_platform::secure_fs::sync_path(&wal)
    });
    if let Err(error) = result {
        if error.kind() == std::io::ErrorKind::NotFound {
            return Ok(());
        }
        return Err(wal_sync_error(error));
    }
    if let Some(parent) = wal.parent() {
        crate::gateway::shutdown_trace::measure_sync("app_sqlite_directory_fsync", || {
            butler_platform::secure_fs::sync_directory(parent).unwrap_or(Ok(()))
        })
        .map_err(wal_sync_error)?;
    }
    Ok(())
}

fn wal_sync_error(error: std::io::Error) -> AppStorageError {
    AppStorageError::new(
        super::AppStorageCode::AppSqliteWalSyncFailed,
        error.to_string(),
    )
    .with_source(error)
}

/// Disable SQLite's implicit checkpoint only after the WAL is durable. Failed
/// initialization and unexpected drops retain SQLite's normal cleanup behavior.
pub(super) fn prepare_close(connection: &Connection) -> StorageResult<()> {
    sync_wal(connection)?;
    connection
        .set_db_config(DbConfig::SQLITE_DBCONFIG_NO_CKPT_ON_CLOSE, true)
        .map_err(AppStorageError::sqlite)?;
    Ok(())
}
