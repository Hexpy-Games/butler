//! Known corrupt files fail immediately; replacements receive full validation.
use super::super::{StorageError, StorageResult, migration, schema};
use super::{validate, verdict};
use rusqlite::Connection;
use std::path::Path;
use tokio_util::sync::CancellationToken;

/// Fail closed on a matching verdict before opening or mutating the database.
pub fn begin_storage_startup(
    path: &Path,
    on_full_validation: impl FnOnce(),
) -> StorageResult<String> {
    if verdict::needs_recheck(path)? {
        on_full_validation();
        return super::read_activated_storage_manifest(path);
    }
    validate::activated::read(path, false, CancellationToken::new(), false)
}

pub(in crate::btcc::storage) fn migrate_current(db: &mut Connection) -> StorageResult<()> {
    schema::create_current(db).map_err(StorageError::sqlite)?;
    let started = std::time::Instant::now();
    migration::apply(db).map_err(StorageError::sqlite)?;
    validate::activated::trace("migrations_applied", started);
    Ok(())
}

/// Successful full validation is the only way to clear a corruption verdict.
pub fn validate_storage_background(path: &Path, stop: CancellationToken) -> StorageResult<()> {
    // The explicit stub-only injection also exercises the optimized scan owner.
    butler_platform::secure_fs::fault_checkpoint("btcc_scan_busy").map_err(|_| {
        StorageError::sqlite(rusqlite::Error::SqliteFailure(
            rusqlite::ffi::Error::new(rusqlite::ffi::SQLITE_BUSY),
            None,
        ))
    })?;
    let result = validate::activated::read(path, true, stop, true).map(|_| ());
    verdict::record_corruption(path, &result);
    result
}

pub fn storage_scan_delay(path: &Path) -> std::time::Duration {
    verdict::scan_delay(path)
}

pub fn storage_error_is_corruption(error: &StorageError) -> bool {
    verdict::corruption(error)
}

/// Stamp a verified replacement without a redundant full startup scan.
pub(in crate::btcc::storage) fn stamp_verified(path: &Path) -> StorageResult<()> {
    verdict::stamp(path)
}

pub(in crate::btcc::storage) fn verify_correction(
    db: &Connection,
    started: std::time::Instant,
) -> StorageResult<Vec<validate::ReferenceFailure>> {
    validate::activated::validate_connection(db, false, started)?;
    validate::correction(db)
}
