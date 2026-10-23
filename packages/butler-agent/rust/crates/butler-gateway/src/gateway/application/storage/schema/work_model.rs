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
    DROP TABLE IF EXISTS app_session_decisions",
    )
    .map_err(AppStorageError::sqlite)?;
    let columns = db
        .prepare("PRAGMA table_info(app_task_sessions)")
        .map_err(AppStorageError::sqlite)?
        .query_map([], |r| r.get::<_, String>(1))
        .map_err(AppStorageError::sqlite)?
        .collect::<rusqlite::Result<Vec<_>>>()
        .map_err(AppStorageError::sqlite)?;
    if !columns.iter().any(|c| c == "coordinator_session_id") {
        db.execute_batch("ALTER TABLE app_task_sessions ADD COLUMN coordinator_session_id TEXT REFERENCES chats(id)").map_err(AppStorageError::sqlite)?;
    }
    db.execute_batch("CREATE INDEX IF NOT EXISTS app_task_sessions_coordinator ON app_task_sessions(coordinator_session_id,task_id,session_id)").map_err(AppStorageError::sqlite)
}

pub(in crate::gateway::application) const RECEIPT: &str =
    "SELECT event_id FROM app_work_model_events WHERE btcc_seq=?1";
pub(in crate::gateway::application) const PRUNE: &str =
    "DELETE FROM app_work_model_events WHERE btcc_seq<=?1";
