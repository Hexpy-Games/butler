//! User-saved browser scraps in the existing App database.
use super::AppStorageError;
use rusqlite::Connection;
pub(super) fn create(db: &Connection) -> Result<(), AppStorageError> {
    db.execute_batch("CREATE TABLE IF NOT EXISTS browser_library(id TEXT PRIMARY KEY,kind TEXT NOT NULL,title TEXT NOT NULL,url TEXT NOT NULL,payload TEXT NOT NULL,created_at TEXT NOT NULL);
        CREATE INDEX IF NOT EXISTS browser_library_kind_time ON browser_library(kind,created_at DESC,id DESC);")
        .map_err(AppStorageError::sqlite)
}
