//! Additive persisted monitor projection with transaction-local invalidation.
use super::AppStorageError;
use rusqlite::{Connection, OptionalExtension};

pub(super) fn migrate(db: &Connection) -> Result<(), AppStorageError> {
    db.execute_batch("CREATE TABLE IF NOT EXISTS app_work_monitor (
       chat_id TEXT PRIMARY KEY, runtime_session_id TEXT NOT NULL, summary TEXT, artifacts_json TEXT NOT NULL);
       CREATE INDEX IF NOT EXISTS idx_work_monitor_runtime ON app_work_monitor(runtime_session_id);
       CREATE TABLE IF NOT EXISTS app_work_monitor_dirty(chat_id TEXT PRIMARY KEY);
       CREATE INDEX IF NOT EXISTS idx_messages_delivered_assistant ON messages(chat_id)
         WHERE role='assistant' AND status='delivered';
       INSERT OR IGNORE INTO app_work_monitor_dirty SELECT id FROM chats
         WHERE NOT EXISTS(SELECT 1 FROM app_work_monitor m WHERE m.chat_id=chats.id);")
       .map_err(AppStorageError::sqlite)?;
    for (table, expression) in [
        ("chats", "SELECT {row}.id"),
        ("messages", "SELECT {row}.chat_id"),
        (
            "message_attachments",
            "SELECT chat_id FROM messages WHERE id={row}.message_id",
        ),
        (
            "message_files",
            "SELECT m.chat_id FROM messages m JOIN message_attachments a ON a.message_id=m.id WHERE a.file_id={row}.id",
        ),
        ("turns", "SELECT {row}.chat_id"),
    ] {
        for (operation, rows) in [
            ("INSERT", vec!["NEW"]),
            ("UPDATE", vec!["OLD", "NEW"]),
            ("DELETE", vec!["OLD"]),
        ] {
            let condition = match (table, operation) {
                ("chats", "UPDATE") => " WHEN OLD.id IS NOT NEW.id",
                ("messages", "UPDATE") => {
                    " WHEN OLD.id IS NOT NEW.id OR OLD.chat_id IS NOT NEW.chat_id OR OLD.turn_id IS NOT NEW.turn_id OR OLD.conversation_session_id IS NOT NEW.conversation_session_id OR OLD.conversation_turn_id IS NOT NEW.conversation_turn_id OR OLD.conversation_message_id IS NOT NEW.conversation_message_id OR OLD.role IS NOT NEW.role OR OLD.status IS NOT NEW.status OR OLD.safe_error_code IS NOT NEW.safe_error_code OR (NEW.role='assistant' AND NEW.status='delivered' AND OLD.text IS NOT NEW.text) OR (NEW.role='user' AND OLD.text IS NOT NEW.text)"
                }
                ("turns", "UPDATE") => {
                    " WHEN OLD.execution_controls_json IS NOT NEW.execution_controls_json OR OLD.user_message_id IS NOT NEW.user_message_id"
                }
                _ => "",
            };
            let mut body = String::new();
            for row in rows {
                let selection = expression.replace("{row}", row);
                body.push_str("INSERT INTO app_work_monitor_dirty ");
                body.push_str(&selection);
                if !selection.contains(" WHERE ") {
                    body.push_str(" WHERE true");
                }
                // UPSERT remains idempotent inside cascading/triggered deletes, where
                // an outer statement's conflict policy can override OR IGNORE.
                body.push_str(" ON CONFLICT(chat_id) DO NOTHING;");
            }

            let name = format!("work_monitor_{table}_{operation}");
            let sql = format!(
                "CREATE TRIGGER {name} AFTER {operation} ON {table}{condition} BEGIN {body} END"
            );
            install_trigger(db, &name, &sql)?;
        }
    }
    Ok(())
}

fn install_trigger(db: &Connection, name: &str, sql: &str) -> Result<(), AppStorageError> {
    let existing: Option<String> = db
        .query_row(
            "SELECT sql FROM sqlite_master WHERE type='trigger' AND name=?1",
            [name],
            |r| r.get(0),
        )
        .optional()
        .map_err(AppStorageError::sqlite)?;
    if existing.as_deref() == Some(sql) {
        return Ok(());
    }
    db.execute_batch(&format!("SAVEPOINT monitor_trigger_upgrade; DROP TRIGGER IF EXISTS {name}; {sql}; RELEASE monitor_trigger_upgrade;"))
        .map_err(AppStorageError::sqlite)
}
