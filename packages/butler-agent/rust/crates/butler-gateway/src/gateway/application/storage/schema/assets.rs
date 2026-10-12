//! Asset identity and indexed lifetime bindings; deletes enqueue files once.
use super::AppStorageError;
use rusqlite::Connection;
pub(super) fn create(db: &Connection) -> Result<(), AppStorageError> {
    db.execute_batch("CREATE TABLE IF NOT EXISTS app_assets(
      id TEXT PRIMARY KEY,sha256 TEXT NOT NULL UNIQUE,mime TEXT NOT NULL,width INTEGER NOT NULL,
      height INTEGER NOT NULL,bytes INTEGER NOT NULL,alt TEXT NOT NULL,source_url TEXT NOT NULL,created_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS app_asset_refs(asset_id TEXT NOT NULL REFERENCES app_assets(id) ON DELETE CASCADE,
      owner_kind TEXT NOT NULL,owner_id TEXT NOT NULL,PRIMARY KEY(asset_id,owner_kind,owner_id));
      CREATE INDEX IF NOT EXISTS app_asset_refs_owner ON app_asset_refs(owner_kind,owner_id);
      CREATE TABLE IF NOT EXISTS app_asset_sweep(sha256 TEXT PRIMARY KEY);
      CREATE TRIGGER IF NOT EXISTS asset_chat_delete AFTER DELETE ON chats BEGIN
        DELETE FROM app_asset_refs WHERE owner_kind='chat' AND owner_id=OLD.id;
      END;
      CREATE TRIGGER IF NOT EXISTS asset_library_delete AFTER DELETE ON browser_library BEGIN
        DELETE FROM app_asset_refs WHERE owner_kind='library' AND owner_id=OLD.id;
      END;
      CREATE TRIGGER IF NOT EXISTS asset_ref_delete AFTER DELETE ON app_asset_refs
      WHEN NOT EXISTS(SELECT 1 FROM app_asset_refs WHERE asset_id=OLD.asset_id) BEGIN
        INSERT INTO app_asset_sweep SELECT sha256 FROM app_assets WHERE id=OLD.asset_id ON CONFLICT(sha256) DO NOTHING;
        DELETE FROM app_assets WHERE id=OLD.asset_id;
      END;
      CREATE TRIGGER IF NOT EXISTS asset_library_insert AFTER INSERT ON browser_library BEGIN
        INSERT INTO app_asset_refs SELECT a.id,'library',NEW.id FROM json_tree(NEW.payload) j
        JOIN app_assets a ON a.id=j.value WHERE j.type='text' ON CONFLICT(asset_id,owner_kind,owner_id) DO NOTHING;
      END;
      CREATE TRIGGER IF NOT EXISTS asset_library_update AFTER UPDATE OF payload ON browser_library BEGIN
        INSERT INTO app_asset_refs SELECT a.id,'library',NEW.id FROM json_tree(NEW.payload) j
        JOIN app_assets a ON a.id=j.value WHERE j.type='text' ON CONFLICT(asset_id,owner_kind,owner_id) DO NOTHING;
        DELETE FROM app_asset_refs WHERE owner_kind='library' AND owner_id=NEW.id
        AND asset_id NOT IN(SELECT value FROM json_tree(NEW.payload) WHERE type='text');
      END;") .map_err(AppStorageError::sqlite)
}
