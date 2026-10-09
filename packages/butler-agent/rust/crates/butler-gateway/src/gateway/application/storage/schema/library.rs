//! Library uses App SQLite plus a derived Script15 FTS5 index.
use super::super::super::library;
use super::AppStorageError;
use rusqlite::{Connection, OptionalExtension};
pub(super) fn create(db: &Connection) -> Result<(), AppStorageError> {
    db.execute_batch("CREATE TABLE IF NOT EXISTS browser_library(id TEXT PRIMARY KEY,kind TEXT NOT NULL,title TEXT NOT NULL,url TEXT NOT NULL,payload TEXT NOT NULL,created_at TEXT NOT NULL);
        CREATE INDEX IF NOT EXISTS browser_library_kind_time ON browser_library(kind,created_at DESC,id DESC);
        CREATE UNIQUE INDEX IF NOT EXISTS browser_bookmark_url ON browser_library(url) WHERE kind='bookmark';
        CREATE VIRTUAL TABLE IF NOT EXISTS browser_library_fts USING fts5(terms);
        CREATE TABLE IF NOT EXISTS browser_library_migration(version INTEGER PRIMARY KEY);").map_err(AppStorageError::sqlite)
}
/// Runs once on the storage owner thread, in bounded primary-key pages.
pub(super) fn recover(
    db: &mut Connection,
    data: Option<&std::path::Path>,
) -> Result<(), AppStorageError> {
    if db
        .query_row(
            "SELECT version FROM browser_library_migration WHERE version=1",
            [],
            |r| r.get::<_, i64>(0),
        )
        .optional()
        .map_err(AppStorageError::sqlite)?
        .is_some()
    {
        return Ok(());
    }
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
