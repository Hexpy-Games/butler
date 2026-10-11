//! Library uses App SQLite plus a derived Script15 FTS5 index.
use super::super::super::library;
use super::AppStorageError;
use rusqlite::{Connection, OptionalExtension};
pub(super) fn create(db: &Connection) -> Result<(), AppStorageError> {
    db.execute_batch("CREATE TABLE IF NOT EXISTS browser_library(id TEXT PRIMARY KEY,kind TEXT NOT NULL,title TEXT NOT NULL,url TEXT NOT NULL,payload TEXT NOT NULL,created_at TEXT NOT NULL);
        CREATE INDEX IF NOT EXISTS browser_library_kind_time ON browser_library(kind,created_at DESC,id DESC);
        CREATE VIRTUAL TABLE IF NOT EXISTS browser_library_fts USING fts5(terms);
        CREATE TABLE IF NOT EXISTS browser_library_snapshot(id TEXT PRIMARY KEY,html TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS browser_library_migration(version INTEGER PRIMARY KEY);
        CREATE TABLE IF NOT EXISTS browser_library_group(id TEXT PRIMARY KEY,kind TEXT NOT NULL,name TEXT NOT NULL,name_key TEXT NOT NULL,position INTEGER NOT NULL,created_at TEXT NOT NULL);
        CREATE UNIQUE INDEX IF NOT EXISTS browser_library_group_name ON browser_library_group(kind,name_key);
        CREATE INDEX IF NOT EXISTS browser_library_group_position ON browser_library_group(kind,position);
        CREATE TABLE IF NOT EXISTS browser_library_tag(norm TEXT PRIMARY KEY,name TEXT NOT NULL) WITHOUT ROWID;
        CREATE TABLE IF NOT EXISTS browser_library_item_tag(item_id TEXT NOT NULL,norm TEXT NOT NULL,PRIMARY KEY(item_id,norm)) WITHOUT ROWID;
        CREATE INDEX IF NOT EXISTS browser_library_tag_items ON browser_library_item_tag(norm,item_id);").map_err(AppStorageError::sqlite)?;
    // Filter and sort keys mirrored from the payload (see `library::refresh`).
    for (column, definition) in [
        ("group_id", "TEXT"),
        ("site", "TEXT NOT NULL DEFAULT ''"),
        ("title_key", "TEXT NOT NULL DEFAULT ''"),
    ] {
        super::migration::ensure_column(db, "browser_library", column, definition)?;
    }
    db.execute_batch("CREATE INDEX IF NOT EXISTS browser_library_time ON browser_library(created_at DESC,id DESC);
        CREATE INDEX IF NOT EXISTS browser_library_group_time ON browser_library(kind,group_id,created_at DESC,id DESC);
        CREATE INDEX IF NOT EXISTS browser_library_site_time ON browser_library(kind,site,created_at DESC,id DESC);
        CREATE INDEX IF NOT EXISTS browser_library_name ON browser_library(kind,title_key,id);").map_err(AppStorageError::sqlite)
}
/// Runs once on the storage owner thread, in bounded primary-key pages.
pub(super) fn recover(
    db: &mut Connection,
    data: Option<&std::path::Path>,
) -> Result<(), AppStorageError> {
    if !migrated(db, 1)? {
        recover_v1(db, data)?;
    }
    if !migrated(db, 2)? {
        // v2: bookmark folders become bookmark groups and every row gets its
        // filter keys. Groups are created in folder-name order (case-insensitive),
        // so their positions follow the names.
        let tx = db.savepoint().map_err(AppStorageError::sqlite)?;
        library::create_folder_groups(&tx)?;
        recover_terms(&tx)?;
        tx.execute(
            "INSERT INTO browser_library_migration(version) VALUES(2)",
            [],
        )
        .map_err(AppStorageError::sqlite)?;
        tx.commit().map_err(AppStorageError::sqlite)?;
    }
    if !migrated(db, 3)? {
        // v3: the same URL may belong to several folders. Migrate once on
        // the storage owner thread, after legacy folders have their group IDs.
        let tx = db.savepoint().map_err(AppStorageError::sqlite)?;
        tx.execute_batch("DROP INDEX IF EXISTS browser_bookmark_url;
            CREATE UNIQUE INDEX browser_bookmark_folder_url ON browser_library(COALESCE(group_id,''),url) WHERE kind='bookmark';
            INSERT INTO browser_library_migration(version) VALUES(3);")
            .map_err(AppStorageError::sqlite)?;
        tx.commit().map_err(AppStorageError::sqlite)?;
    }
    Ok(())
}
fn migrated(db: &Connection, version: i64) -> Result<bool, AppStorageError> {
    db.query_row(
        "SELECT version FROM browser_library_migration WHERE version=?1",
        [version],
        |r| r.get::<_, i64>(0),
    )
    .optional()
    .map(|found| found.is_some())
    .map_err(AppStorageError::sqlite)
}
fn recover_v1(db: &mut Connection, data: Option<&std::path::Path>) -> Result<(), AppStorageError> {
    let tx = db.savepoint().map_err(AppStorageError::sqlite)?;
    recover_documents(&tx)?;
    if let Some(data) = data {
        recover_outputs(&tx, data)?;
    }
    recover_terms(&tx)?;
    tx.execute(
        "INSERT INTO browser_library_migration(version) VALUES(1)",
        [],
    )
    .map_err(AppStorageError::sqlite)?;
    tx.commit().map_err(AppStorageError::sqlite)
}
fn recover_documents(db: &Connection) -> Result<(), AppStorageError> {
    let mut after = String::new();
    loop {
        let mut query=db.prepare("SELECT f.id FROM message_files f JOIN messages m ON m.id=f.message_id WHERE f.id>?1 AND m.role='assistant' ORDER BY f.id LIMIT 500").map_err(AppStorageError::sqlite)?;
        let ids = query
            .query_map([&after], |r| r.get::<_, String>(0))
            .map_err(AppStorageError::sqlite)?
            .collect::<Result<Vec<_>, _>>()
            .map_err(AppStorageError::sqlite)?;
        if ids.is_empty() {
            break;
        }
        for id in &ids {
            library::document(db, id)?;
        }
        after = ids.last().cloned().unwrap_or_default();
    }
    Ok(())
}
fn recover_outputs(db: &Connection, data: &std::path::Path) -> Result<(), AppStorageError> {
    let store = butler_runtime::outputs::OutputStore::new(data);
    let mut after = String::new();
    loop {
        let page = store.library_page(&after).map_err(|e| {
            AppStorageError::new(super::super::AppStorageCode::AppJsonFailed, e.to_string())
        })?;
        if page.is_empty() {
            break;
        }
        after = page.last().map(|o| o.output_id.clone()).unwrap_or_default();
        for item in page {
            library::save(db, &library::output(&item))?;
        }
    }
    Ok(())
}
fn recover_terms(db: &Connection) -> Result<(), AppStorageError> {
    let mut after = String::new();
    loop {
        let mut query = db
            .prepare("SELECT id,payload FROM browser_library WHERE id>?1 ORDER BY id LIMIT 500")
            .map_err(AppStorageError::sqlite)?;
        let rows = query
            .query_map([&after], |r| {
                Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?))
            })
            .map_err(AppStorageError::sqlite)?
            .collect::<Result<Vec<_>, _>>()
            .map_err(AppStorageError::sqlite)?;
        if rows.is_empty() {
            break;
        }
        for (id, text) in rows {
            let item = serde_json::from_str(&text).map_err(|e| {
                AppStorageError::new(super::super::AppStorageCode::AppJsonFailed, e.to_string())
            })?;
            library::save(db, &item)?;
            after = id;
        }
    }
    Ok(())
}
