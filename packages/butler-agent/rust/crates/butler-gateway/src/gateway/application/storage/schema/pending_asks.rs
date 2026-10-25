use super::AppStorageError;
use rusqlite::Connection;

pub(super) fn create(db: &Connection) -> Result<(), AppStorageError> {
    db.execute_batch(
        "CREATE TABLE IF NOT EXISTS app_pending_ask_cursor (id INTEGER PRIMARY KEY CHECK(id=1), seq INTEGER NOT NULL);
        INSERT OR IGNORE INTO app_pending_ask_cursor(id,seq) VALUES(1,0);",
    )
    .map_err(AppStorageError::sqlite)
}
