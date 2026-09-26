use serde::Serialize;

use super::super::sessions::AppSessionSummary;

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) enum AppProjectSource {
    Scratch,
    ExistingFolder,
}

#[derive(Clone, Debug)]
pub(crate) struct AppCreateProjectRequest {
    pub source: AppProjectSource,
    pub display_name: Option<String>,
    pub folder_selection_token: Option<String>,
}

#[derive(Clone, Debug, Serialize)]
pub(crate) struct AppProjectSummary {
    pub id: String,
    pub display_name: String,
    pub status: String,
    pub last_activity_at: String,
    pub active_session_count: usize,
    pub pinned: bool,
    pub archived: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error_summary: Option<String>,
    pub workspace_label: String,
    pub safe_path_label: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub sessions: Option<Vec<AppSessionSummary>>,
}

#[derive(Clone, Debug, Serialize)]
pub(crate) struct AppCreateProjectResult {
    pub project: AppProjectSummary,
}

#[derive(Clone, Debug, Serialize)]
pub(crate) struct AppProjectList {
    pub projects: Vec<AppProjectSummary>,
}
