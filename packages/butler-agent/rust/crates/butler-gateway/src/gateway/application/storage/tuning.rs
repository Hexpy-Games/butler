//! Connection tuning for the App database: page cache, memory map, statement
//! cache, query-planner statistics and WAL size.

use std::time::Duration;

use rusqlite::Connection;

use super::{AppStorageError, StorageResult};

/// Compiled statements the lane keeps for `prepare_cached`.
const CACHED_STATEMENTS: usize = 256;
/// Bound resident pages to 8 MiB; indexed foreground reads need no large cache.
const PAGE_CACHE_KIB: i64 = -8_192;
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

/// Folds the WAL into the database file and truncates it.
pub(super) fn checkpoint(connection: &Connection) -> StorageResult<()> {
    connection
        .execute_batch("PRAGMA wal_checkpoint(TRUNCATE)")
        .map_err(AppStorageError::sqlite)
}
