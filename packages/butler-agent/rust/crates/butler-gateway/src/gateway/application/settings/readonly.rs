//! Read-only App preferences that do not start or mutate the service.

use std::path::Path;

use butler_platform::sqlite;
use rusqlite::OpenFlags;
use serde_json::Value;

use super::{AppStorageError, SETTINGS_KEY, read_json};

/// Read the App-owned preference without starting or mutating the App service.
/// Missing or unreadable settings leave diagnostics disabled.
pub fn diagnostics_enabled_readonly(database_path: &Path) -> bool {
    let Ok(db) = sqlite::open_with_flags(database_path, OpenFlags::SQLITE_OPEN_READ_ONLY) else {
        return false;
    };
    read_json(&db, SETTINGS_KEY)
        .ok()
        .flatten()
        .and_then(|settings| settings.get("diagnostics_enabled").and_then(Value::as_bool))
        == Some(true)
}

/// Stored App language, without creating a database or selecting a fallback.
pub fn stored_ui_language_readonly(
    database_path: &Path,
) -> Result<Option<String>, crate::gateway::GatewayApplicationError> {
    stored_ui_language(database_path)
        .map_err(crate::gateway::GatewayApplicationError::internal_from)
}

fn stored_ui_language(database_path: &Path) -> Result<Option<String>, AppStorageError> {
    if !database_path.exists() {
        return Ok(None);
    }
    let db = sqlite::open_with_flags(database_path, OpenFlags::SQLITE_OPEN_READ_ONLY)
        .map_err(AppStorageError::sqlite)?;
    let exists: bool = db
        .query_row(
            "SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE type='table' AND name='app_settings')",
            [],
            |row| row.get(0),
        )
        .map_err(AppStorageError::sqlite)?;
    if !exists {
        return Ok(None);
    }
    Ok(read_json(&db, SETTINGS_KEY)?.and_then(|settings| {
        settings
            .get("language")
            .and_then(Value::as_str)
            .map(str::to_owned)
    }))
}
