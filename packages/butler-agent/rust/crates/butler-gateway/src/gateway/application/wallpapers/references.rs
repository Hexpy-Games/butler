//! What refers to a wallpaper asset or module; deletion is refused while
//! anything does.
//!
//! Each scope that can hold a wallpaper source is one scan returning the
//! labels of its references: the global setting's source and every project's
//! `dashboard_preferences_json.wallpaper` (`"inherit"` or a source).

use rusqlite::Connection;
use serde_json::Value;

use super::super::{AppStorageError, settings};

/// Whether a source refers to the id.
type Refers = fn(&Value, &str) -> bool;

/// What shows asset `id`, matching sources with [`settings::source_image_asset`].
pub(super) fn find(db: &Connection, id: &str) -> Result<Vec<String>, AppStorageError> {
    scan(db, id, |source, id| {
        settings::source_image_asset(source) == Some(id)
    })
}

/// What draws with module `id`: a live source or an image source's filter.
pub(super) fn module(db: &Connection, id: &str) -> Result<Vec<String>, AppStorageError> {
    scan(db, id, |source, id| {
        let module = |value: Option<&Value>| {
            value
                .and_then(|value| value.get("module"))
                .and_then(Value::as_str)
                == Some(id)
        };
        (source.get("kind").and_then(Value::as_str) == Some("live") && module(Some(source)))
            || module(source.get("filter"))
    })
}

fn scan(db: &Connection, id: &str, refers: Refers) -> Result<Vec<String>, AppStorageError> {
    let mut found = global_setting(db, id, refers)?;
    found.extend(projects(db, id, refers)?);
    Ok(found)
}

fn global_setting(
    db: &Connection,
    id: &str,
    refers: Refers,
) -> Result<Vec<String>, AppStorageError> {
    let source = settings::stored_wallpaper_source(db)?;
    Ok(source
        .filter(|source| refers(source, id))
        .map(|_| "settings.wallpaper".to_owned())
        .into_iter()
        .collect())
}

/// Every project, archived ones included. `instr` narrows the rows to those
/// mentioning the id before their JSON is read.
fn projects(db: &Connection, id: &str, refers: Refers) -> Result<Vec<String>, AppStorageError> {
    let mut statement = db
        .prepare(
            "SELECT id,dashboard_preferences_json FROM projects \
             WHERE instr(dashboard_preferences_json,?1)>0 ORDER BY id",
        )
        .map_err(AppStorageError::sqlite)?;
    let rows = statement
        .query_map([id], |row| {
            Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
        })
        .map_err(AppStorageError::sqlite)?;
    let mut found = Vec::new();
    for row in rows {
        let (project, preferences) = row.map_err(AppStorageError::sqlite)?;
        let preferences = serde_json::from_str::<Value>(&preferences).ok();
        let wallpaper = preferences
            .as_ref()
            .and_then(|value| value.get("wallpaper"));
        if wallpaper.is_some_and(|source| refers(source, id)) {
            found.push(format!("projects.{project}.wallpaper"));
        }
    }
    Ok(found)
}
