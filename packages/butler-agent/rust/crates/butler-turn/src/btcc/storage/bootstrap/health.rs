//! WAL-atomic startup fence; a clean marker is published only by the service
//! after every producer and SQLite owner has closed successfully.
use std::path::Path;

use butler_platform::sqlite;
use rusqlite::{Connection, OptionalExtension};
use tokio_util::sync::CancellationToken;

use super::super::{StorageError, StorageResult, migration, schema};
use super::{manifest::digest, validate};

const HEALTH_SCHEMA: &str = "CREATE TABLE IF NOT EXISTS agent_storage_health (
 singleton INTEGER PRIMARY KEY CHECK(singleton=1), clean INTEGER NOT NULL,
 schema_version INTEGER NOT NULL, migration_revision TEXT NOT NULL)";

fn revision() -> String {
    digest(
        concat!(
            include_str!("../schema.rs"),
            include_str!("../schema/core.rs"),
            include_str!("../schema/work.rs"),
            include_str!("../schema/effects.rs"),
            include_str!("../schema/authority.rs"),
            include_str!("../schema/subsession.rs"),
            include_str!("../schema/legacy.rs"),
            include_str!("../migration.rs"),
            include_str!("../migration/authority.rs"),
            include_str!("../migration/subsession.rs"),
            include_str!("../migration/monitoring.rs"),
            include_str!("../migration/startup_indexes.rs"),
        )
        .as_bytes(),
    )
}

fn current(db: &Connection) -> StorageResult<bool> {
    let exists: bool = db.query_row(
        "SELECT EXISTS(SELECT 1 FROM sqlite_schema WHERE name='agent_storage_health' AND type='table')",
        [], |row| row.get(0),
    ).map_err(StorageError::sqlite)?;
    if !exists {
        return Ok(false);
    }
    let stamp: Option<(i64, String)> = db
        .query_row(
            "SELECT schema_version,migration_revision FROM agent_storage_health WHERE singleton=1",
            [],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .optional()
        .map_err(StorageError::sqlite)?;
    let version: i64 = db
        .pragma_query_value(None, "schema_version", |row| row.get(0))
        .map_err(StorageError::sqlite)?;
    Ok(stamp.is_some_and(|(saved, code)| saved == version && code == revision()))
}

/// Validate before any startup mutation; the writer durably clears the fence.
/// Missing markers (including older installations) always receive a full scan.
pub fn begin_storage_startup(path: &Path) -> StorageResult<String> {
    let db = sqlite::open_with_flags(path, rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY)
        .map_err(StorageError::sqlite)?;
    let clean = current(&db)?
        && db
            .query_row(
                "SELECT clean=1 FROM agent_storage_health WHERE singleton=1",
                [],
                |row| row.get::<_, bool>(0),
            )
            .map_err(StorageError::sqlite)?;
    drop(db);
    validate::activated::read(path, !clean, CancellationToken::new(), false)
}

pub(in crate::btcc::storage) fn migrate_current(db: &mut Connection) -> StorageResult<()> {
    let started = std::time::Instant::now();
    let migrated = current(db)?;
    // This fence is synced before any runtime owner/migration/Turn can write,
    // including callers that open storage without the service bootstrap.
    db.pragma_update(None, "synchronous", "FULL")
        .map_err(StorageError::sqlite)?;
    db.execute_batch(HEALTH_SCHEMA)
        .map_err(StorageError::sqlite)?;
    db.execute("INSERT INTO agent_storage_health VALUES(1,0,-1,'') ON CONFLICT(singleton) DO UPDATE SET clean=0", [])
        .map_err(StorageError::sqlite)?;
    db.pragma_update(None, "synchronous", "NORMAL")
        .map_err(StorageError::sqlite)?;
    if migrated {
        validate::activated::trace("migrations_unchanged", started);
        return Ok(());
    }
    schema::create_current(db).map_err(StorageError::sqlite)?;
    migration::apply(db).map_err(StorageError::sqlite)?;
    validate::activated::trace("migrations_applied", started);
    validate::integrity(db)?;
    db.execute_batch(HEALTH_SCHEMA)
        .map_err(StorageError::sqlite)?;
    let version: i64 = db
        .pragma_query_value(None, "schema_version", |row| row.get(0))
        .map_err(StorageError::sqlite)?;
    db.execute("INSERT INTO agent_storage_health VALUES(1,0,?1,?2) ON CONFLICT(singleton) DO UPDATE SET schema_version=excluded.schema_version,migration_revision=excluded.migration_revision", rusqlite::params![version, revision()])
        .map_err(StorageError::sqlite)?;
    Ok(())
}

/// Called after successful graceful service shutdown, never from Drop/error paths.
pub fn finish_storage_shutdown(path: &Path) -> StorageResult<()> {
    let db = sqlite::open(path).map_err(StorageError::sqlite)?;
    db.pragma_update(None, "synchronous", "FULL")
        .map_err(StorageError::sqlite)?;
    db.set_db_config(
        rusqlite::config::DbConfig::SQLITE_DBCONFIG_NO_CKPT_ON_CLOSE,
        true,
    )
    .map_err(StorageError::sqlite)?;
    db.execute(
        "UPDATE agent_storage_health SET clean=1 WHERE singleton=1",
        [],
    )
    .map_err(StorageError::sqlite)?;
    Ok(())
}

/// Complete read-only snapshot validation, interruptible when the service stops.
pub fn validate_storage_background(path: &Path, stop: CancellationToken) -> StorageResult<()> {
    validate::activated::read(path, true, stop, true).map(|_| ())
}
