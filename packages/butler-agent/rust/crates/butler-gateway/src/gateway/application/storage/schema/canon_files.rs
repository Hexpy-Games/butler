//! App owns file lifetimes; canon owns descriptions and publishes references.
use super::super::AppStorageError;
use rusqlite::Connection;

pub(super) fn create(db: &Connection) -> Result<(), AppStorageError> {
    db.execute_batch("CREATE INDEX IF NOT EXISTS message_attachments_file ON message_attachments(file_id);
      CREATE TABLE IF NOT EXISTS app_canon_epic_files(
      epic_id TEXT NOT NULL,file_id TEXT NOT NULL REFERENCES message_files(id),
      PRIMARY KEY(epic_id,file_id));
      CREATE INDEX IF NOT EXISTS app_canon_epic_files_file ON app_canon_epic_files(file_id);
      CREATE TABLE IF NOT EXISTS app_file_sweep(file_id TEXT PRIMARY KEY);
      CREATE TABLE IF NOT EXISTS app_file_pending(file_id TEXT PRIMARY KEY REFERENCES message_files(id) ON DELETE CASCADE,
      expires_at TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS app_file_pending_expiry ON app_file_pending(expires_at);
      CREATE TRIGGER IF NOT EXISTS canon_file_ref_delete AFTER DELETE ON app_canon_epic_files
      WHEN NOT EXISTS(SELECT 1 FROM app_canon_epic_files WHERE file_id=OLD.file_id) BEGIN
        INSERT OR IGNORE INTO app_file_sweep SELECT id FROM message_files WHERE id=OLD.file_id
        AND message_id IS NULL AND owner_session_id IS NULL;
      END;
      CREATE TRIGGER IF NOT EXISTS canon_file_owner_update AFTER UPDATE OF message_id,owner_session_id ON message_files
      WHEN NEW.message_id IS NULL AND NEW.owner_session_id IS NULL
      AND NOT EXISTS(SELECT 1 FROM app_canon_epic_files WHERE file_id=NEW.id) BEGIN
        INSERT OR IGNORE INTO app_file_sweep VALUES(NEW.id);
      END;").map_err(AppStorageError::sqlite)
}

pub(in crate::gateway::application) const EPIC_FILES: &str =
    "SELECT file_id FROM app_canon_epic_files WHERE epic_id=?1 ORDER BY file_id";
pub(in crate::gateway::application) const EXPIRED: &str =
    "SELECT p.file_id FROM app_file_pending p WHERE p.expires_at<=?1
    AND NOT EXISTS(SELECT 1 FROM app_canon_epic_files r WHERE r.file_id=p.file_id)";
pub(in crate::gateway::application) const DELETE_UNUSED: &str =
    "DELETE FROM message_files WHERE id=?1 AND message_id IS NULL AND owner_session_id IS NULL
    AND NOT EXISTS(SELECT 1 FROM app_canon_epic_files WHERE file_id=?1)
    AND NOT EXISTS(SELECT 1 FROM app_file_pending WHERE file_id=?1)";

pub(in crate::gateway::application) const SWEEP_QUEUE: &str =
    "SELECT file_id FROM app_file_sweep ORDER BY file_id LIMIT 100";
pub(in crate::gateway::application) const REMOVE_SWEEP: &str =
    "DELETE FROM app_file_sweep WHERE file_id=?1";
pub(in crate::gateway::application) const DELETE_PENDING: &str =
    "DELETE FROM app_file_pending WHERE file_id=?1";
pub(in crate::gateway::application) const REMOVE_REFS: &str =
    "DELETE FROM app_canon_epic_files WHERE epic_id=?1
    AND file_id NOT IN(SELECT value FROM json_each(?2))";

pub(in crate::gateway::application) const DELETE_EXPIRED: &str =
    "DELETE FROM app_file_pending WHERE expires_at<=?1
    AND NOT EXISTS(SELECT 1 FROM app_canon_epic_files WHERE file_id=app_file_pending.file_id)";

/// An installed reference already protects its file. A rejected edit must not
/// leave an extra pending lifetime that delays removal of that reference.
pub(in crate::gateway::application) const PIN_PENDING: &str =
    "INSERT INTO app_file_pending SELECT ?1,?2
    WHERE NOT EXISTS(SELECT 1 FROM app_canon_epic_files WHERE file_id=?1)
    ON CONFLICT(file_id) DO UPDATE SET expires_at=excluded.expires_at";
