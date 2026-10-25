//! Kinds: collected, original, generated and mask. Asset identity and indexed lifetime bindings; deletes enqueue files once.
use super::AppStorageError;
use rusqlite::Connection;
pub(super) fn create(db: &Connection) -> Result<(), AppStorageError> {
    db.execute_batch("CREATE TABLE IF NOT EXISTS app_assets(
      id TEXT PRIMARY KEY,sha256 TEXT NOT NULL,mime TEXT NOT NULL,width INTEGER NOT NULL,
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
      CREATE TRIGGER IF NOT EXISTS asset_message_delete AFTER DELETE ON messages BEGIN
        DELETE FROM app_asset_refs WHERE owner_kind='message' AND owner_id=OLD.id;
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
      END;").map_err(AppStorageError::sqlite)?;
    super::asset_versions::migrate(db)?;
    generated_columns(db)?;
    message_bindings(db)
}

/// T3 owns the column; install its indexed media bindings once it is present.
fn message_bindings(db: &Connection) -> Result<(), AppStorageError> {
    let mut columns = db
        .prepare("PRAGMA table_info(messages)")
        .map_err(AppStorageError::sqlite)?;
    let columns = columns
        .query_map([], |r| r.get::<_, String>(1))
        .map_err(AppStorageError::sqlite)?;
    let mut present = false;
    for name in columns {
        present |= name.map_err(AppStorageError::sqlite)? == "blocks_json";
    }
    if !present {
        return Ok(());
    }
    db.execute_batch("CREATE TRIGGER IF NOT EXISTS asset_message_insert AFTER INSERT ON messages BEGIN
      INSERT INTO app_asset_refs SELECT a.id,'message',NEW.id FROM json_tree(COALESCE(NEW.blocks_json,'[]')) j
      JOIN app_assets a ON a.id=j.value WHERE j.type='text' ON CONFLICT(asset_id,owner_kind,owner_id) DO NOTHING;
      END;
      CREATE TRIGGER IF NOT EXISTS asset_message_update AFTER UPDATE OF blocks_json ON messages BEGIN
      INSERT INTO app_asset_refs SELECT a.id,'message',NEW.id FROM json_tree(COALESCE(NEW.blocks_json,'[]')) j
      JOIN app_assets a ON a.id=j.value WHERE j.type='text' ON CONFLICT(asset_id,owner_kind,owner_id) DO NOTHING;
      DELETE FROM app_asset_refs WHERE owner_kind='message' AND owner_id=NEW.id
      AND asset_id NOT IN(SELECT value FROM json_tree(COALESCE(NEW.blocks_json,'[]')) WHERE type='text');
      END;") .map_err(AppStorageError::sqlite)
}

fn generated_columns(db: &Connection) -> Result<(), AppStorageError> {
    for (name, declaration) in [
        ("pixel_ratio", "REAL NOT NULL DEFAULT 1"),
        ("kind", "TEXT NOT NULL DEFAULT 'collected'"),
        ("parent_id", "TEXT"),
        ("model_ref", "TEXT"),
    ] {
        super::migration::ensure_column(db, "app_assets", name, declaration)?;
    }
    db.execute_batch(
        "CREATE INDEX IF NOT EXISTS app_assets_sha ON app_assets(sha256);
      CREATE INDEX IF NOT EXISTS app_assets_parent ON app_assets(parent_id);
      CREATE TRIGGER IF NOT EXISTS asset_version_delete AFTER DELETE ON app_assets BEGIN
        DELETE FROM app_asset_refs WHERE owner_kind='asset' AND owner_id=OLD.id;
      END;",
    )
    .map_err(AppStorageError::sqlite)
}
