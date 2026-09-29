//! `app_wallpaper_module_status` rows: the App's last check of each user
//! module, for the revision of the files it checked.

use std::collections::HashMap;

use rusqlite::{Connection, OptionalExtension, params};

use super::super::AppStorageError;
use crate::gateway::wallpaper_modules::user::ModuleStatus;

pub(super) fn all(db: &Connection) -> Result<HashMap<String, ModuleStatus>, AppStorageError> {
    let mut statement = db
        .prepare("SELECT id,revision,state,message,checked_at FROM app_wallpaper_module_status")
        .map_err(AppStorageError::sqlite)?;
    statement
        .query_map([], |row| {
            Ok((
                row.get::<_, String>(0)?,
                ModuleStatus {
                    revision: row.get(1)?,
                    state: row.get(2)?,
                    message: row.get(3)?,
                    checked_at: row.get(4)?,
                },
            ))
        })
        .and_then(|rows| rows.collect())
        .map_err(AppStorageError::sqlite)
}

/// The App's last check of module `id`, if any.
pub(super) fn get(db: &Connection, id: &str) -> Result<Option<ModuleStatus>, AppStorageError> {
    db.query_row(
        "SELECT revision,state,message,checked_at FROM app_wallpaper_module_status WHERE id=?1",
        [id],
        |row| {
            Ok(ModuleStatus {
                revision: row.get(0)?,
                state: row.get(1)?,
                message: row.get(2)?,
                checked_at: row.get(3)?,
            })
        },
    )
    .optional()
    .map_err(AppStorageError::sqlite)
}

pub(super) fn put(db: &Connection, id: &str, status: &ModuleStatus) -> Result<(), AppStorageError> {
    db.execute(
        "INSERT INTO app_wallpaper_module_status (id,revision,state,message,checked_at) \
         VALUES (?1,?2,?3,?4,?5) ON CONFLICT(id) DO UPDATE SET revision=excluded.revision,\
         state=excluded.state,message=excluded.message,checked_at=excluded.checked_at",
        params![
            id,
            status.revision,
            status.state,
            status.message,
            status.checked_at
        ],
    )
    .map(|_| ())
    .map_err(AppStorageError::sqlite)
}

pub(super) fn delete(db: &Connection, id: &str) -> Result<(), AppStorageError> {
    db.execute("DELETE FROM app_wallpaper_module_status WHERE id=?1", [id])
        .map(|_| ())
        .map_err(AppStorageError::sqlite)
}
