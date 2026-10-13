//! Per-chat read markers for the sidebar unread dot.
//!
//! A chat is unread when its latest finished assistant reply has a message
//! rowid above the chat's read marker. Chats without a marker use the
//! baseline: the highest message rowid when this table first appeared, so the
//! history that predates the feature never shows as unread and no message row
//! is scanned to seed markers.
use super::super::AppStorageError;
use rusqlite::Connection;

pub(super) fn create(db: &Connection) -> Result<(), AppStorageError> {
    db.execute_batch(SCHEMA).map_err(AppStorageError::sqlite)
}

const SCHEMA: &str = r"
CREATE TABLE IF NOT EXISTS app_session_reads (
 chat_id TEXT PRIMARY KEY REFERENCES chats(id) ON DELETE CASCADE,
 read_rowid INTEGER NOT NULL,
 read_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS app_session_read_baseline (
 singleton INTEGER PRIMARY KEY CHECK(singleton=1),
 baseline_rowid INTEGER NOT NULL
);
INSERT OR IGNORE INTO app_session_read_baseline(singleton,baseline_rowid)
 SELECT 1,COALESCE(MAX(rowid),0) FROM messages;
";
