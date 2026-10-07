//! Immutable General history is owned by a small, atomic rowid extent record.
use super::AppStorageError;
use rusqlite::Connection;

pub(super) fn migrate(db: &Connection) -> Result<(), AppStorageError> {
    let tx = db
        .unchecked_transaction()
        .map_err(AppStorageError::sqlite)?;
    tx.execute_batch(SCHEMA).map_err(AppStorageError::sqlite)?;
    tx.commit().map_err(AppStorageError::sqlite)
}

const SCHEMA: &str = r"
CREATE TABLE IF NOT EXISTS app_general_history (
    archive_id TEXT PRIMARY KEY REFERENCES chats(id) ON DELETE CASCADE,
    first_rowid INTEGER NOT NULL,
    last_rowid INTEGER NOT NULL UNIQUE,
    CHECK(first_rowid <= last_rowid)
);
-- The existing (chat_id,role,created_at,id) index cannot seek a rowid range.
-- A single-column index orders each chat by its implicit rowid.
CREATE INDEX IF NOT EXISTS messages_chat_rowid_idx ON messages(chat_id);
-- Replace definitions atomically on startup, including definitions from older builds.
DROP VIEW IF EXISTS app_owned_messages;
DROP VIEW IF EXISTS app_message_owners;
DROP TRIGGER IF EXISTS general_history_delete;
-- General's physical rows retain their creation owner. Reads resolve their extent.
CREATE VIEW app_owned_messages AS
SELECT rowid AS rowid, id, chat_id, turn_id, conversation_session_id, conversation_turn_id,
       conversation_message_id, role, text, status, created_at, updated_at,
       safe_error_code, retryable, plan_json, content_parts_json FROM messages WHERE chat_id <> 'general'
UNION ALL
SELECT rowid AS rowid, id, chat_id, turn_id, conversation_session_id, conversation_turn_id,
       conversation_message_id, role, text, status, created_at, updated_at,
       safe_error_code, retryable, plan_json, content_parts_json FROM messages
WHERE chat_id = 'general'
  AND rowid > COALESCE((SELECT MAX(last_rowid) FROM app_general_history), 0)
UNION ALL
SELECT m.rowid, m.id, h.archive_id, m.turn_id, m.conversation_session_id,
       m.conversation_turn_id, m.conversation_message_id, m.role, m.text,
       m.status, m.created_at, m.updated_at, m.safe_error_code, m.retryable,
       m.plan_json, m.content_parts_json
FROM app_general_history h CROSS JOIN messages m
WHERE m.chat_id = 'general' AND m.rowid BETWEEN h.first_rowid AND h.last_rowid;
-- Parent ownership keeps project ranges outermost in dashboard joins.
-- Use the unique identity index so SQLite can preserve message rowid order.
CREATE VIEW app_message_owners AS
SELECT c.id AS chat_id,
       CASE WHEN h.archive_id IS NOT NULL THEN 'general' ELSE c.id END AS source_chat_id,
       CASE WHEN c.id='general' THEN COALESCE((SELECT MAX(last_rowid) FROM app_general_history),0)+1
            ELSE COALESCE(h.first_rowid, -9223372036854775808) END AS first_rowid,
       COALESCE(h.last_rowid, 9223372036854775807) AS last_rowid
FROM chats c INDEXED BY sqlite_autoindex_chats_1
LEFT JOIN app_general_history h ON h.archive_id=c.id;
-- Deleting an archive removes its physical messages/FTS/attachments before
-- its extent disappears. The permanent General identity is never deleted.
CREATE TRIGGER general_history_delete BEFORE DELETE ON chats
BEGIN
    DELETE FROM messages WHERE chat_id = 'general'
      AND rowid BETWEEN
          (SELECT first_rowid FROM app_general_history WHERE archive_id = OLD.id)
      AND (SELECT last_rowid FROM app_general_history WHERE archive_id = OLD.id);
END;
";
