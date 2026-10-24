use super::AppStorageError;
use rusqlite::Connection;

pub(super) fn create(db: &Connection) -> Result<(), AppStorageError> {
    db.execute_batch(r"
        CREATE TABLE IF NOT EXISTS app_open_plan_decisions (
            chat_id TEXT PRIMARY KEY REFERENCES chats(id) ON DELETE CASCADE,
            plan_id TEXT NOT NULL, message_id TEXT NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
            created_at TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS app_open_plan_decisions_created ON app_open_plan_decisions(created_at);
        CREATE INDEX IF NOT EXISTS app_open_plan_decisions_message ON app_open_plan_decisions(message_id);
        CREATE TABLE IF NOT EXISTS app_pending_ask_changes (
            seq INTEGER PRIMARY KEY AUTOINCREMENT, chat_id TEXT NOT NULL, ask_id TEXT NOT NULL, state TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS app_pending_ask_cursor (id INTEGER PRIMARY KEY CHECK(id=1), seq INTEGER NOT NULL);
        INSERT OR IGNORE INTO app_pending_ask_cursor(id,seq) VALUES(1,0);
        CREATE TRIGGER IF NOT EXISTS pending_plan_archive AFTER UPDATE OF archived ON chats
        WHEN NEW.archived=1 AND OLD.archived=0 BEGIN
            INSERT INTO app_pending_ask_changes(chat_id,ask_id,state)
                SELECT chat_id,'plan:'||plan_id,'closed' FROM app_open_plan_decisions WHERE chat_id=NEW.id;
            DELETE FROM app_open_plan_decisions WHERE chat_id=NEW.id;
        END;
        CREATE TRIGGER IF NOT EXISTS pending_plan_rotate AFTER UPDATE OF runtime_session_hint ON chats
        WHEN OLD.runtime_session_hint IS NOT NEW.runtime_session_hint BEGIN
            INSERT INTO app_pending_ask_changes(chat_id,ask_id,state)
                SELECT chat_id,'plan:'||plan_id,'closed' FROM app_open_plan_decisions WHERE chat_id=NEW.id;
            DELETE FROM app_open_plan_decisions WHERE chat_id=NEW.id;
        END;
        CREATE TRIGGER IF NOT EXISTS pending_plan_delete BEFORE DELETE ON chats BEGIN
            INSERT INTO app_pending_ask_changes(chat_id,ask_id,state)
                SELECT chat_id,'plan:'||plan_id,'closed' FROM app_open_plan_decisions WHERE chat_id=OLD.id;
            DELETE FROM app_open_plan_decisions WHERE chat_id=OLD.id;
        END;
    ").map_err(AppStorageError::sqlite)?;
    backfill(db)
}

// One seek per logical chat, including General's archived rowid extents.
pub(crate) const LATEST_ASSISTANT: &str = "SELECT id,created_at,plan_json FROM messages INDEXED BY messages_chat_assistant_rowid WHERE chat_id=?1 AND role='assistant' AND rowid BETWEEN ?2 AND ?3 ORDER BY rowid DESC LIMIT 1";

fn backfill(db: &Connection) -> Result<(), AppStorageError> {
    use rusqlite::{OptionalExtension, params};
    let tx = db
        .unchecked_transaction()
        .map_err(AppStorageError::sqlite)?;
    tx.execute_batch(
        "CREATE TABLE IF NOT EXISTS app_pending_ask_migrations(version INTEGER PRIMARY KEY);",
    )
    .map_err(AppStorageError::sqlite)?;
    let done = tx
        .query_row(
            "SELECT 1 FROM app_pending_ask_migrations WHERE version=1",
            [],
            |_| Ok(()),
        )
        .optional()
        .map_err(AppStorageError::sqlite)?
        .is_some();
    if !done {
        tx.execute_batch("CREATE INDEX IF NOT EXISTS messages_chat_assistant_rowid ON messages(chat_id) WHERE role='assistant';")
            .map_err(AppStorageError::sqlite)?;
        let mut chats = tx.prepare("SELECT o.chat_id,o.source_chat_id,o.first_rowid,o.last_rowid FROM app_message_owners o JOIN chats c ON c.id=o.chat_id WHERE c.archived=0")
            .map_err(AppStorageError::sqlite)?;
        let owners = chats
            .query_map([], |r| {
                Ok((
                    r.get::<_, String>(0)?,
                    r.get::<_, String>(1)?,
                    r.get::<_, i64>(2)?,
                    r.get::<_, i64>(3)?,
                ))
            })
            .map_err(AppStorageError::sqlite)?;
        for owner in owners {
            let (chat, source, first, last) = owner.map_err(AppStorageError::sqlite)?;
            let latest = tx
                .query_row(LATEST_ASSISTANT, params![source, first, last], |r| {
                    Ok((
                        r.get::<_, String>(0)?,
                        r.get::<_, String>(1)?,
                        r.get::<_, Option<String>>(2)?,
                    ))
                })
                .optional()
                .map_err(AppStorageError::sqlite)?;
            if let Some((message, created, Some(raw))) = latest {
                let Ok(plan) = serde_json::from_str::<serde_json::Value>(&raw) else {
                    continue;
                };
                if plan["status"] == "draft"
                    && let Some(id) = plan["id"].as_str()
                {
                    tx.execute("INSERT OR IGNORE INTO app_open_plan_decisions(chat_id,plan_id,message_id,created_at) VALUES(?1,?2,?3,?4)", params![chat,id,message,created])
                        .map_err(AppStorageError::sqlite)?;
                }
            }
        }
        tx.execute(
            "INSERT INTO app_pending_ask_migrations(version) VALUES(1)",
            [],
        )
        .map_err(AppStorageError::sqlite)?;
    }
    tx.commit().map_err(AppStorageError::sqlite)
}
