//! Receipts bridge App append and BTCC acknowledgement across a crash.
use super::super::AppStorageError;
use rusqlite::Connection;

pub(super) fn create(db: &Connection) -> Result<(), AppStorageError> {
    db.execute_batch(
        "CREATE TABLE IF NOT EXISTS app_work_model_events (
        btcc_seq INTEGER PRIMARY KEY, event_id INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS app_canon_session_deletes (
        op_id TEXT PRIMARY KEY, session_hint TEXT NOT NULL
    )",
    )
    .map_err(AppStorageError::sqlite)
}

pub(in crate::gateway::application) const RECEIPT: &str =
    "SELECT event_id FROM app_work_model_events WHERE btcc_seq=?1";
pub(in crate::gateway::application) const PRUNE: &str =
    "DELETE FROM app_work_model_events WHERE btcc_seq<=?1";
