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

/// Workspace navigation and the question about a project's folder, for the same clients
/// as project lists.
pub trait GatewayProjectFolders {
    /// The hooks of a project's folder, if nobody answered for it yet.
    fn project_folder_question(
        &self,
        _project_id: String,
    ) -> crate::gateway::ApplicationFuture<Option<butler_core::hooks::ProjectHookRequest>> {
        Box::pin(async { Err(GatewayApplicationError::internal()) })
    }
    /// Answers that question, for the list of hooks the person saw.
    fn answer_project_folder(
        &self,
        _project_id: String,
        _hooks: Vec<butler_core::hooks::ProjectHookLine>,
        _trusted: bool,
    ) -> crate::gateway::ApplicationFuture<()> {
        Box::pin(async { Err(GatewayApplicationError::internal()) })
    }
    fn list_project_folders(
        &self,
        _path: String,
        _after: Option<String>,
    ) -> crate::gateway::ApplicationFuture<serde_json::Value> {
        Box::pin(async { Err(GatewayApplicationError::internal()) })
    }
}

impl GatewayProjectFolders for super::AppApplication {
    fn project_folder_question(
        &self,
        project_id: String,
    ) -> crate::gateway::ApplicationFuture<Option<butler_core::hooks::ProjectHookRequest>> {
        let this = self.clone_handle();
        Box::pin(async move { this.project_folder_question(project_id).await })
    }
    fn answer_project_folder(
        &self,
        project_id: String,
        hooks: Vec<butler_core::hooks::ProjectHookLine>,
        trusted: bool,
    ) -> crate::gateway::ApplicationFuture<()> {
        let this = self.clone_handle();
        Box::pin(async move { this.answer_project_folder(project_id, hooks, trusted).await })
    }
    fn list_project_folders(
        &self,
        path: String,
        after: Option<String>,
    ) -> crate::gateway::ApplicationFuture<serde_json::Value> {
        let root = self.project_creation.workspace_root();
        Box::pin(async move {
            tokio::task::spawn_blocking(move || {
                projects::workspace_folder::list(&root, &path, after.as_deref())
            })
            .await
            .map_err(GatewayApplicationError::internal_from)?
        })
    }
}

/// Exercise the shared resolver from the dev-only security suite without raising
/// the gateway's non-E2E test ratchet.
#[cfg(feature = "test-support")]
pub fn resolve_workspace_folder(
    root: &Path,
    path: &str,
) -> Result<Option<PathBuf>, GatewayApplicationError> {
    projects::workspace_folder::resolve(root, path).map(|folder| folder.map(|folder| folder.path))
}
