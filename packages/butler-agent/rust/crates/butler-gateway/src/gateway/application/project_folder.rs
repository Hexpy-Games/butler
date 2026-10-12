//! Canonical project-folder validation and stopped-service preference access.

pub use super::projects::token::issue as selection_token;
use super::{projects, settings::persistence};
use crate::gateway::GatewayApplicationError;
use rusqlite::Connection;
use serde_json::json;
use std::path::{Path, PathBuf};

/// Same canonical directory checks as native folder selection, excluding DATA.
pub fn validate(path: &Path, data: &Path) -> Result<PathBuf, GatewayApplicationError> {
    let path = projects::folder::validate_existing(path)?;
    let data = butler_platform::secure_fs::canonicalize(data)
        .or_else(|error| {
            if error.kind() == std::io::ErrorKind::NotFound && data.is_absolute() {
                Ok(data.to_path_buf())
            } else {
                Err(error)
            }
        })
        .map_err(GatewayApplicationError::internal_from)?;
    if path.starts_with(data) {
        return Err(GatewayApplicationError::Public {
            status: 400,
            code: "project_folder_unsafe".into(),
            message: "Project folder must be outside DATA.".into(),
            source: None,
        });
    }
    Ok(path)
}

/// Reads the indexed preference or the effective, unpersisted home fallback.
pub fn read(db: Option<&Connection>) -> Result<PathBuf, GatewayApplicationError> {
    if let Some(db) = db {
        let exists: bool = db.query_row("SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE type='table' AND name='app_settings')", [], |row| row.get(0))
            .map_err(GatewayApplicationError::internal_from)?;
        if exists {
            return projects::effective_root(db).map_err(super::app_error);
        }
    }
    butler_platform::user_dirs::non_empty_home_dir()
        .map(|home| home.join("butler-workspace"))
        .ok_or_else(GatewayApplicationError::internal)
}

/// Only for a stopped service; runtime updates use PATCH /settings.
pub fn write(db: &Connection, path: &Path, now: &str) -> Result<(), GatewayApplicationError> {
    super::storage::create_settings_table(db).map_err(super::app_error)?;
    persistence::write_json(db, "default-project-workspace-root", &json!(path), now)
        .map_err(super::app_error)
}

/// Shared Settings projection for the selected folder.
pub(super) fn project(output: &mut serde_json::Map<String, serde_json::Value>, root: &Path) {
    let label = root
        .file_name()
        .and_then(|name| name.to_str())
        .filter(|name| !name.is_empty())
        .unwrap_or("Project");
    output.insert("default_project_workspace_label".into(), json!(label));
    output.insert("default_project_workspace_path".into(), json!(root));
}
