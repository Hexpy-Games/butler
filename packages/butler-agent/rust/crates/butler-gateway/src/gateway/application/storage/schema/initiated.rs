//! Durable, idempotent delivery and report-pause bookkeeping.
use super::{AppStorageError, migration};
use rusqlite::Connection;

pub(super) fn create(db: &Connection) -> Result<(), AppStorageError> {
    migration::ensure_column(db, "app_automations", "report_paused_at", "TEXT")?;
    migration::ensure_column(db, "app_automations", "report_count_since", "TEXT")?;
    db.execute_batch(
        "CREATE TABLE IF NOT EXISTS app_automation_policy_holds(
         run_id TEXT PRIMARY KEY REFERENCES app_automation_runs(id) ON DELETE CASCADE,
         since TEXT, until TEXT, excluded_ms INTEGER NOT NULL DEFAULT 0);
         CREATE TABLE IF NOT EXISTS app_initiated_messages(
         id TEXT PRIMARY KEY, chat_id TEXT NOT NULL, kind TEXT NOT NULL,
         source_key TEXT NOT NULL UNIQUE, text TEXT NOT NULL, payload_json TEXT NOT NULL,
         bypass_quiet_hours INTEGER NOT NULL DEFAULT 0,
         state TEXT NOT NULL, message_id TEXT, quiet INTEGER NOT NULL DEFAULT 0,
         created_at TEXT NOT NULL, posted_at TEXT);
         CREATE INDEX IF NOT EXISTS initiated_state_created_idx
         ON app_initiated_messages(state,created_at);
         CREATE UNIQUE INDEX IF NOT EXISTS initiated_message_idx
         ON app_initiated_messages(message_id) WHERE message_id IS NOT NULL;",
    )
    .map_err(AppStorageError::sqlite)?;
    migration::ensure_column(db, "app_initiated_messages", "reason", "TEXT")?;
    migration::ensure_column(
        db,
        "app_initiated_messages",
        "attempts",
        "INTEGER NOT NULL DEFAULT 0",
    )?;
    migration::ensure_column(db, "app_initiated_messages", "next_attempt_at", "TEXT")?;
    migration::ensure_column(
        db,
        "app_initiated_messages",
        "posting",
        "INTEGER NOT NULL DEFAULT 0",
    )?;
    db.execute(
        "UPDATE app_initiated_messages SET posting=0 WHERE posting<>0",
        [],
    )
    .map_err(AppStorageError::sqlite)?;
    db.execute("CREATE INDEX IF NOT EXISTS initiated_posting_chat_idx ON app_initiated_messages(chat_id) WHERE state='held' AND kind='work_result' AND posting=1", []).map_err(AppStorageError::sqlite)?;
    db.execute("CREATE INDEX IF NOT EXISTS initiated_stuck_chat_idx ON app_initiated_messages(chat_id,attempts) WHERE state='held' AND kind='work_result'", []).map_err(AppStorageError::sqlite)?;
    migration::ensure_column(db, "turns", "quiet", "INTEGER NOT NULL DEFAULT 0")?;
    db.execute("UPDATE app_initiated_messages SET payload_json=json_remove(payload_json,'$.access_mode'),bypass_quiet_hours=NOT (COALESCE(json_extract(payload_json,'$.schedule_run.unattended'),0) OR COALESCE(json_extract(payload_json,'$.schedule_run.connector_event'),0)) WHERE state='held' AND kind='work_result' AND json_valid(payload_json)", [])
        .map_err(AppStorageError::sqlite)?;
    Ok(())
}
