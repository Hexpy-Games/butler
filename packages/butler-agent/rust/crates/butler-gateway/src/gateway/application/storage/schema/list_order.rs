//! Change-driven sort history for five-minute list cursors. No read snapshots
//! hold WAL readers open, and no background worker maintains this history.
use super::{AppStorageError, Connection};

pub(super) fn create(db: &Connection) -> Result<(), AppStorageError> {
    db.execute_batch(r"
CREATE TABLE IF NOT EXISTS app_list_revision(id INTEGER PRIMARY KEY CHECK(id=1), revision INTEGER NOT NULL);
INSERT OR IGNORE INTO app_list_revision VALUES(1,0);
CREATE TABLE IF NOT EXISTS app_list_order(
 id TEXT NOT NULL, revision INTEGER NOT NULL, ended INTEGER, expires INTEGER,
 pinned INTEGER NOT NULL, updated_at TEXT NOT NULL, created_at TEXT NOT NULL,
 archived INTEGER NOT NULL, kind TEXT NOT NULL, project_id TEXT,
 PRIMARY KEY(id,revision));
CREATE UNIQUE INDEX IF NOT EXISTS list_order_current ON app_list_order(id) WHERE ended IS NULL;
CREATE INDEX IF NOT EXISTS list_chats_keyset ON app_list_order
 (archived,updated_at DESC,created_at DESC,id DESC,revision);
CREATE INDEX IF NOT EXISTS list_sessions_keyset ON app_list_order
 (archived,pinned DESC,updated_at DESC,created_at DESC,id DESC,revision);
CREATE INDEX IF NOT EXISTS list_order_expiry ON app_list_order(expires) WHERE expires IS NOT NULL;
INSERT OR IGNORE INTO app_list_order
 SELECT id,0,NULL,NULL,pinned,updated_at,created_at,archived,kind,project_id FROM chats
 WHERE NOT EXISTS(SELECT 1 FROM app_list_order LIMIT 1);
CREATE TRIGGER IF NOT EXISTS list_order_insert AFTER INSERT ON chats BEGIN
 UPDATE app_list_revision SET revision=revision+1 WHERE id=1;
 INSERT INTO app_list_order SELECT NEW.id,revision,NULL,NULL,NEW.pinned,NEW.updated_at,
 NEW.created_at,NEW.archived,NEW.kind,NEW.project_id FROM app_list_revision WHERE id=1;
 DELETE FROM app_list_order WHERE (id,revision) IN
 (SELECT id,revision FROM app_list_order WHERE expires<unixepoch() ORDER BY expires LIMIT 64);
END;
CREATE TRIGGER IF NOT EXISTS list_order_update AFTER UPDATE OF
 pinned,updated_at,created_at,archived,kind,project_id ON chats
 WHEN OLD.pinned IS NOT NEW.pinned OR OLD.updated_at IS NOT NEW.updated_at
 OR OLD.created_at IS NOT NEW.created_at OR OLD.archived IS NOT NEW.archived
 OR OLD.kind IS NOT NEW.kind OR OLD.project_id IS NOT NEW.project_id BEGIN
 UPDATE app_list_revision SET revision=revision+1 WHERE id=1;
 UPDATE app_list_order SET ended=(SELECT revision FROM app_list_revision WHERE id=1),
 expires=unixepoch()+300 WHERE id=OLD.id AND ended IS NULL;
 INSERT INTO app_list_order SELECT NEW.id,revision,NULL,NULL,NEW.pinned,NEW.updated_at,
 NEW.created_at,NEW.archived,NEW.kind,NEW.project_id FROM app_list_revision WHERE id=1;
 DELETE FROM app_list_order WHERE (id,revision) IN
 (SELECT id,revision FROM app_list_order WHERE expires<unixepoch() ORDER BY expires LIMIT 64);
END;
CREATE TRIGGER IF NOT EXISTS list_order_delete AFTER DELETE ON chats BEGIN
 UPDATE app_list_revision SET revision=revision+1 WHERE id=1;
 UPDATE app_list_order SET ended=(SELECT revision FROM app_list_revision WHERE id=1),
 expires=unixepoch()+300 WHERE id=OLD.id AND ended IS NULL;
END;
").map_err(AppStorageError::sqlite)
}
