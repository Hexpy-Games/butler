//! Editable Markdown documents have their own history, independent of file deliverables.
use super::AppStorageError;
use rusqlite::Connection;
pub(super) fn create(db: &Connection) -> Result<(), AppStorageError> {
    db.execute_batch("CREATE TABLE IF NOT EXISTS documents(
      id TEXT PRIMARY KEY,title TEXT NOT NULL,chat_id TEXT,message_id TEXT,head_rev INTEGER NOT NULL,
      created_at TEXT NOT NULL,updated_at TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS documents_chat ON documents(chat_id);
      CREATE INDEX IF NOT EXISTS documents_message ON documents(chat_id,message_id);
      CREATE TABLE IF NOT EXISTS document_deliveries(
      document_id TEXT NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
      chat_id TEXT NOT NULL,message_id TEXT NOT NULL,PRIMARY KEY(document_id,chat_id,message_id));
      CREATE INDEX IF NOT EXISTS document_deliveries_message ON document_deliveries(chat_id,message_id);
      CREATE TABLE IF NOT EXISTS document_bodies(sha256 TEXT PRIMARY KEY,body TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS document_revisions(
      document_id TEXT NOT NULL REFERENCES documents(id) ON DELETE CASCADE,rev INTEGER NOT NULL,
      sha256 TEXT NOT NULL REFERENCES document_bodies(sha256),author TEXT NOT NULL CHECK(author IN ('user','butler')),
      created_at TEXT NOT NULL,updated_at TEXT NOT NULL,PRIMARY KEY(document_id,rev));
      CREATE INDEX IF NOT EXISTS document_revisions_body ON document_revisions(sha256);
      CREATE TABLE IF NOT EXISTS document_seen(document_id TEXT NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
      chat_id TEXT NOT NULL,rev INTEGER NOT NULL,PRIMARY KEY(document_id,chat_id));
      CREATE INDEX IF NOT EXISTS document_seen_chat ON document_seen(chat_id,document_id);
      CREATE INDEX IF NOT EXISTS document_seen_revision ON document_seen(document_id,rev);
      CREATE TABLE IF NOT EXISTS session_queued_document_edits(
      queued_id TEXT PRIMARY KEY REFERENCES session_queued_messages(id) ON DELETE CASCADE,edits_json TEXT NOT NULL);
      CREATE TRIGGER IF NOT EXISTS document_body_delete AFTER DELETE ON document_bodies BEGIN
        DELETE FROM app_asset_refs WHERE owner_kind='document_body' AND owner_id=OLD.sha256;
      END;") .map_err(AppStorageError::sqlite)
}
