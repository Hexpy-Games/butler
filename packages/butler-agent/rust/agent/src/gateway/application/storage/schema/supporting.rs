use rusqlite::Connection;

use super::super::AppStorageError;

pub(super) fn create(connection: &Connection) -> Result<(), AppStorageError> {
    connection
        .execute_batch(SUPPORTING_SCHEMA)
        .map_err(AppStorageError::sqlite)
}

const SUPPORTING_SCHEMA: &str = r"
CREATE TABLE IF NOT EXISTS app_terminal_turn_projections (
  turn_id TEXT PRIMARY KEY REFERENCES turns(id) ON DELETE CASCADE,
  chat_id TEXT NOT NULL REFERENCES chats(id) ON DELETE CASCADE,
  terminal_state TEXT NOT NULL,
  progress_rows_json TEXT NOT NULL,
  delivery_metadata_json TEXT,
  source_event_high_water INTEGER NOT NULL,
  compacted_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS app_terminal_turn_progress_rows (
  turn_id TEXT NOT NULL REFERENCES turns(id) ON DELETE CASCADE,
  source_event_id INTEGER NOT NULL,
  row_json TEXT NOT NULL,
  PRIMARY KEY (turn_id, source_event_id)
) WITHOUT ROWID;
CREATE TABLE IF NOT EXISTS app_terminal_turn_snapshot_state (
  turn_id TEXT PRIMARY KEY REFERENCES turns(id) ON DELETE CASCADE,
  target_event_id INTEGER NOT NULL,
  cursor_event_id INTEGER NOT NULL
) WITHOUT ROWID;
CREATE TABLE IF NOT EXISTS app_progress_row_identities (
  turn_id TEXT NOT NULL,
  row_json TEXT NOT NULL,
  PRIMARY KEY (turn_id, row_json)
) WITHOUT ROWID;
CREATE TABLE IF NOT EXISTS app_internal_continuation_progress_events (
  turn_id TEXT NOT NULL REFERENCES turns(id) ON DELETE CASCADE,
  event_id TEXT NOT NULL,
  source_event_id INTEGER,
  PRIMARY KEY (turn_id, event_id)
) WITHOUT ROWID;

CREATE INDEX IF NOT EXISTS messages_role_created_idx ON messages(role, created_at, id);
CREATE INDEX IF NOT EXISTS messages_chat_role_created_idx ON messages(chat_id, role, created_at, id);
CREATE VIRTUAL TABLE IF NOT EXISTS messages_fts USING fts5(text, tokenize = 'unicode61');
INSERT INTO messages_fts(rowid, text)
SELECT messages.rowid, messages.text FROM messages
WHERE NOT EXISTS (SELECT 1 FROM messages_fts WHERE messages_fts.rowid = messages.rowid);
CREATE TRIGGER IF NOT EXISTS messages_fts_ai AFTER INSERT ON messages BEGIN
  INSERT INTO messages_fts(rowid, text) VALUES (new.rowid, new.text);
END;
CREATE TRIGGER IF NOT EXISTS messages_fts_ad AFTER DELETE ON messages BEGIN
  DELETE FROM messages_fts WHERE rowid = old.rowid;
END;
CREATE TRIGGER IF NOT EXISTS messages_fts_au AFTER UPDATE OF text ON messages BEGIN
  DELETE FROM messages_fts WHERE rowid = old.rowid;
  INSERT INTO messages_fts(rowid, text) VALUES (new.rowid, new.text);
END;
";
