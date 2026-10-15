//! Indexed visits; URL summaries make suggestions independent of visit count.
use super::AppStorageError;
use rusqlite::Connection;
pub(in crate::gateway::application) fn create(db: &Connection) -> Result<(), AppStorageError> {
    db.execute_batch("CREATE TABLE IF NOT EXISTS browser_history(
        id INTEGER PRIMARY KEY, url TEXT NOT NULL, title TEXT NOT NULL, favicon TEXT NOT NULL,
        visited_at INTEGER NOT NULL, transition TEXT NOT NULL, tab_kind TEXT NOT NULL,
        conversation_id TEXT, butler_driven INTEGER NOT NULL, source TEXT NOT NULL,
        UNIQUE(url,visited_at));
        CREATE INDEX IF NOT EXISTS browser_history_source ON browser_history(source);
        CREATE INDEX IF NOT EXISTS browser_history_time ON browser_history(visited_at DESC,id DESC);
        CREATE INDEX IF NOT EXISTS browser_history_driven_time ON browser_history(butler_driven,visited_at DESC,id DESC);
        CREATE INDEX IF NOT EXISTS browser_history_url_time ON browser_history(url,visited_at DESC,id DESC);
        CREATE TABLE IF NOT EXISTS browser_history_url(id INTEGER PRIMARY KEY,url TEXT NOT NULL UNIQUE,
            title TEXT NOT NULL,favicon TEXT NOT NULL,last_visit INTEGER NOT NULL,visits INTEGER NOT NULL);
        CREATE INDEX IF NOT EXISTS browser_history_url_latest ON browser_history_url(last_visit DESC);
        CREATE VIRTUAL TABLE IF NOT EXISTS browser_history_visit_fts USING fts5(terms,prefix='2 3 4');
        CREATE TRIGGER IF NOT EXISTS browser_history_delete AFTER DELETE ON browser_history BEGIN
            DELETE FROM browser_history_visit_fts WHERE rowid=old.id;
        END;
        CREATE VIRTUAL TABLE IF NOT EXISTS browser_history_fts USING fts5(terms,prefix='2 3 4');
        CREATE TRIGGER IF NOT EXISTS browser_history_url_delete AFTER DELETE ON browser_history_url BEGIN
            DELETE FROM browser_history_fts WHERE rowid=old.id;
        END;")
        .map_err(AppStorageError::sqlite)
}
