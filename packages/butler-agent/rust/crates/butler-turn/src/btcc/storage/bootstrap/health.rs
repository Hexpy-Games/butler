//! Startup checks only metadata. Full validation belongs to the serving worker.
use super::super::{StorageError, StorageResult, migration, schema};
use super::{validate, verdict};
use rusqlite::Connection;
use std::path::Path;
use tokio_util::sync::CancellationToken;

/// SQLite open/schema errors and a persisted corruption verdict fail fast.
pub fn begin_storage_startup(path: &Path) -> StorageResult<String> {
    verdict::require_healthy(path)?;
    validate::activated::read(path, false, CancellationToken::new(), false)
}

/// This is a migration version, advanced when the migration contract changes.
const MIGRATION_VERSION: i64 = 1;

pub(in crate::btcc::storage) fn migrate_current(db: &mut Connection) -> StorageResult<()> {
    let version: i64 = db
        .pragma_query_value(None, "user_version", |row| row.get(0))
        .map_err(StorageError::sqlite)?;
    if version == MIGRATION_VERSION {
        return Ok(());
    }
    if version > MIGRATION_VERSION {
        return Err(super::error(
            crate::btcc::StorageCode::AgentBtccStorageManifestMismatch,
        ));
    }
    // Adopt an origin/main DB without replaying data backfills. Comparing the
    // bounded schema catalog also handles installations predating user_version.
    let before = objects(db)?;
    let mut expected = Connection::open_in_memory().map_err(StorageError::sqlite)?;
    schema::create_current(&expected).map_err(StorageError::sqlite)?;
    migration::apply_transaction(&mut expected).map_err(StorageError::sqlite)?;
    if before != objects(&expected)? {
        migrate_changed(db, &before)?;
    }
    db.pragma_update(None, "user_version", MIGRATION_VERSION)
        .map_err(StorageError::sqlite)
}

type Objects = std::collections::BTreeMap<(String, String), String>;

fn objects(db: &Connection) -> StorageResult<Objects> {
    let mut statement = db
        .prepare(
            "SELECT type,name,sql FROM sqlite_schema
        WHERE name LIKE 'btcc_%' OR name LIKE 'idx_btcc_%' ORDER BY type,name",
        )
        .map_err(StorageError::sqlite)?;
    statement
        .query_map([], |row| Ok(((row.get(0)?, row.get(1)?), row.get(2)?)))
        .map_err(StorageError::sqlite)?
        .collect::<rusqlite::Result<Objects>>()
        .map_err(StorageError::sqlite)
}

fn migrate_changed(db: &mut Connection, before: &Objects) -> StorageResult<()> {
    let touched = std::sync::Arc::new(std::sync::Mutex::new(std::collections::BTreeSet::new()));
    let writes = touched.clone();
    db.update_hook(Some(move |_, _: &str, table: &str, _| {
        if let Ok(mut tables) = writes.lock() {
            tables.insert(table.to_owned());
        }
    }));
    let migrated = schema::create_current(db).and_then(|()| migration::apply(db));
    db.update_hook(None::<fn(rusqlite::hooks::Action, &str, &str, i64)>);
    migrated.map_err(StorageError::sqlite)?;
    let mut tables = touched.lock().map_err(|_| {
        StorageError::relayed(
            "migration_tracking_failed",
            "migration tracking lock poisoned",
        )
    })?;
    let after = objects(db)?;
    tables.retain(|name| after.contains_key(&("table".to_owned(), name.clone())));
    for ((kind, name), sql) in after {
        if kind == "table" && before.get(&(kind, name.clone())) != Some(&sql) {
            tables.insert(name);
        }
    }
    for table in tables.iter() {
        validate::foreign_keys(db, Some(table))?;
    }
    Ok(())
}

/// Successful full validation is the only way to clear a corruption verdict.
pub fn validate_storage_background(path: &Path, stop: CancellationToken) -> StorageResult<()> {
    // Reuse the platform's debug-only one-shot fault harness; release builds
    // never consult its environment or create its marker.
    butler_platform::secure_fs::fault_checkpoint("btcc_scan_busy").map_err(|_| {
        StorageError::sqlite(rusqlite::Error::SqliteFailure(
            rusqlite::ffi::Error::new(rusqlite::ffi::SQLITE_BUSY),
            None,
        ))
    })?;
    let result =
        validate::activated::read(path, true, stop, true).and_then(|_| verdict::verified(path));
    verdict::record_corruption(path, &result);
    result
}

pub fn storage_scan_delay(path: &Path) -> std::time::Duration {
    verdict::scan_delay(path)
}

pub fn storage_error_is_corruption(error: &StorageError) -> bool {
    verdict::corruption(error)
}
