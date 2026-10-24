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
    ").map_err(AppStorageError::sqlite)
}
