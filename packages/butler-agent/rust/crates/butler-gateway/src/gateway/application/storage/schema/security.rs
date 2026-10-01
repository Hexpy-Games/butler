use super::super::AppStorageError;
use rusqlite::Connection;

pub(super) fn create(db: &Connection) -> Result<(), AppStorageError> {
    db.execute_batch(
        "CREATE TABLE IF NOT EXISTS paired_devices (
        id TEXT PRIMARY KEY, secret_hash BLOB NOT NULL, name TEXT NOT NULL,
        ip TEXT NOT NULL, created_at INTEGER NOT NULL, last_seen_at INTEGER NOT NULL,
        revoked_at INTEGER
    );",
    )
    .map_err(AppStorageError::sqlite)
}
