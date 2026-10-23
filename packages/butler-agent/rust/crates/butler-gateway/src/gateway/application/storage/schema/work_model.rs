//! Receipts bridge App append and BTCC acknowledgement across a crash.
use super::super::AppStorageError;
use rusqlite::Connection;

pub(super) fn create(db: &Connection) -> Result<(), AppStorageError> {
    db.execute_batch(
        "CREATE TABLE IF NOT EXISTS app_work_model_events (
        btcc_seq INTEGER PRIMARY KEY, event_id INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS app_task_sessions (
        session_id TEXT PRIMARY KEY REFERENCES chats(id) ON DELETE CASCADE,
        task_id TEXT NOT NULL, work_id TEXT NOT NULL, op_id TEXT NOT NULL UNIQUE
    );
    CREATE INDEX IF NOT EXISTS app_task_sessions_work ON app_task_sessions(work_id,task_id);
    CREATE TABLE IF NOT EXISTS app_session_decisions (
        id TEXT PRIMARY KEY, session_id TEXT NOT NULL REFERENCES chats(id) ON DELETE CASCADE,
        task_id TEXT NOT NULL, payload_json TEXT NOT NULL CHECK(json_valid(payload_json)), decision TEXT
    );
    CREATE INDEX IF NOT EXISTS app_session_decisions_pending ON app_session_decisions(session_id,id) WHERE decision IS NULL",

    )
    .map_err(AppStorageError::sqlite)
}

pub(in crate::gateway::application) const RECEIPT: &str =
    "SELECT event_id FROM app_work_model_events WHERE btcc_seq=?1";
pub(in crate::gateway::application) const PRUNE: &str =
    "DELETE FROM app_work_model_events WHERE btcc_seq<=?1";
