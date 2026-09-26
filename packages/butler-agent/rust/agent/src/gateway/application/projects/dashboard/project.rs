use rusqlite::{Connection, OptionalExtension};
use serde_json::Value;

use super::super::AppProjectSummary;
use super::super::{AppApplication, AppStorageError, GatewayApplicationError, app_error};
use super::contracts::project_not_found;
use crate::gateway::AppSessionSummary;

#[derive(Clone, Debug)]
pub(super) struct DashboardProject {
    pub id: String,
    pub display_name: String,
    pub status: String,
    pub workspace_path: String,
    pub workspace_label: String,
    pub safe_path_label: String,
    pub ledger_project_id: Option<String>,
    pub pinned: bool,
    pub archived: bool,
    pub error_summary: Option<String>,
    pub updated_at: String,
    pub description: Option<String>,
    pub preferences_json: Option<String>,
    pub preferences_revision: u64,
}

pub(super) async fn read_project(
    application: &AppApplication,
    project_id: &str,
) -> Result<DashboardProject, GatewayApplicationError> {
    let key = project_id.to_owned();
    application
        .storage
        .execute(move |db| read(db, &key))
        .await
        .map_err(app_error)?
        .ok_or_else(project_not_found)
}

pub(super) fn read(
    db: &Connection,
    project_id: &str,
) -> Result<Option<DashboardProject>, AppStorageError> {
    db.query_row(
        "SELECT id,display_name,status,workspace_path,workspace_label,safe_path_label,\
         ledger_project_id,pinned,archived,error_summary,updated_at,description,\
         dashboard_preferences_json,dashboard_preferences_revision FROM projects WHERE id=?1",
        [project_id],
        |row| {
            Ok(DashboardProject {
                id: row.get(0)?,
                display_name: row.get(1)?,
                status: row.get(2)?,
                workspace_path: row.get(3)?,
                workspace_label: row.get(4)?,
                safe_path_label: row.get(5)?,
                ledger_project_id: row.get(6)?,
                pinned: row.get::<_, i64>(7)? == 1,
                archived: row.get::<_, i64>(8)? == 1,
                error_summary: row.get(9)?,
                updated_at: row.get(10)?,
                description: row.get(11)?,
                preferences_json: row.get(12)?,
                preferences_revision: u64::try_from(row.get::<_, i64>(13)?.max(0))
                    .unwrap_or_default(),
            })
        },
    )
    .optional()
    .map_err(AppStorageError::sqlite)
}

pub(super) fn project_summary(
    project: &DashboardProject,
    sessions: Vec<AppSessionSummary>,
) -> AppProjectSummary {
    let last_activity_at = sessions
        .iter()
        .map(|session| session.last_activity_at.as_str())
        .max()
        .unwrap_or(&project.updated_at)
        .to_owned();
    AppProjectSummary {
        id: project.id.clone(),
        display_name: project.display_name.clone(),
        status: project.status.clone(),
        last_activity_at,
        active_session_count: sessions.iter().filter(|session| !session.archived).count(),
        pinned: project.pinned,
        archived: project.archived,
        error_summary: project.error_summary.clone(),
        workspace_label: project.workspace_label.clone(),
        safe_path_label: project.safe_path_label.clone(),
        sessions: Some(sessions),
    }
}

pub(super) fn preferences(project: &DashboardProject) -> Result<Value, AppStorageError> {
    match project.preferences_json.as_deref() {
        Some(raw) => serde_json::from_str(raw).map_err(|error| {
            AppStorageError::new("app_project_preferences_invalid", error.to_string())
        }),
        None => Ok(serde_json::json!({})),
    }
}

pub(super) fn pins(project: &DashboardProject) -> Result<Vec<Value>, AppStorageError> {
    let value = preferences(project)?;
    match value.get("pinnedSourceRefs") {
        Some(Value::Array(values)) => Ok(values.clone()),
        Some(_) => Err(AppStorageError::new(
            "app_project_preferences_invalid",
            "Project dashboard preferences are invalid.",
        )),
        None => Ok(Vec::new()),
    }
}
