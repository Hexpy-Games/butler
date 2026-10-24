//! Permit distinct lineage occurrences to share one content-addressed blob.
use super::AppStorageError;
use rusqlite::Connection;
pub(super) fn migrate(db: &Connection) -> Result<(), AppStorageError> {
    let sql: String = db
        .query_row(
            "SELECT sql FROM sqlite_master WHERE type='table' AND name='app_assets'",
            [],
            |r| r.get(0),
        )
        .map_err(AppStorageError::sqlite)?;
    if !sql.contains("sha256 TEXT NOT NULL UNIQUE") {
        return Ok(());
    }
    let mut statement = db
        .prepare(
            "SELECT name,sql FROM sqlite_master WHERE type='trigger' AND sql LIKE '%app_assets%'",
        )
        .map_err(AppStorageError::sqlite)?;
    let triggers = statement
        .query_map([], |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?)))
        .map_err(AppStorageError::sqlite)?
        .collect::<Result<Vec<_>, _>>()
        .map_err(AppStorageError::sqlite)?;
    drop(statement);
    let foreign_keys: bool = db
        .pragma_query_value(None, "foreign_keys", |r| r.get(0))
        .map_err(AppStorageError::sqlite)?;
    db.pragma_update(None, "foreign_keys", false)
        .map_err(AppStorageError::sqlite)?;
    let result = rebuild(db, &sql, &triggers);
    if result.is_err() {
        let _ = db.execute_batch("ROLLBACK");
    }
    db.pragma_update(None, "foreign_keys", foreign_keys)
        .map_err(AppStorageError::sqlite)?;
    result
}
fn rebuild(
    db: &Connection,
    sql: &str,
    triggers: &[(String, String)],
) -> Result<(), AppStorageError> {
    db.execute_batch("BEGIN IMMEDIATE")
        .map_err(AppStorageError::sqlite)?;
    for (name, _) in triggers {
        db.execute_batch(&format!("DROP TRIGGER \"{}\"", name.replace('"', "\"\"")))
            .map_err(AppStorageError::sqlite)?;
    }
    let create = sql
        .replacen("app_assets", "app_assets_next", 1)
        .replace("sha256 TEXT NOT NULL UNIQUE", "sha256 TEXT NOT NULL");
    db.execute_batch(&create).map_err(AppStorageError::sqlite)?;
    db.execute_batch("INSERT INTO app_assets_next SELECT * FROM app_assets; DROP TABLE app_assets; ALTER TABLE app_assets_next RENAME TO app_assets;").map_err(AppStorageError::sqlite)?;
    for (_, sql) in triggers {
        db.execute_batch(sql).map_err(AppStorageError::sqlite)?;
    }
    db.execute_batch("COMMIT").map_err(AppStorageError::sqlite)
}
