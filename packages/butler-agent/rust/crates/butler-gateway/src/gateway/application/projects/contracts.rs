use serde::Serialize;

use super::super::sessions::AppSessionSummary;

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum AppProjectSource {
    Scratch,
    ExistingFolder,
}

#[derive(Clone, Debug)]
pub struct AppCreateProjectRequest {
    pub source: AppProjectSource,
    pub display_name: Option<String>,
    pub folder_selection_token: Option<String>,
}

#[derive(Clone, Debug, Serialize)]
pub struct AppProjectSummary {
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
    /// The project folder's Git state: in the project list (`is_repo` and
    /// `branch` only) and the project dashboard (all of it).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub git: Option<AppProjectGit>,
}

/// A project folder's Git state; what is not known is `null`.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize)]
pub struct AppProjectGit {
    /// The folder is in a Git repository.
    pub is_repo: bool,
    /// The checked-out branch; `null` for a detached HEAD or no repository.
    pub branch: Option<String>,
    /// Uncommitted changes or untracked files (dashboard only).
    pub dirty: Option<bool>,
    /// Commits not yet on the upstream branch (dashboard only; `null`
    /// without an upstream).
    pub ahead: Option<u32>,
    /// Upstream commits not yet on the branch (dashboard only; `null`
    /// without an upstream).
    pub behind: Option<u32>,
}

#[derive(Clone, Debug, Serialize)]
pub struct AppCreateProjectResult {
    pub project: AppProjectSummary,
}

#[derive(Clone, Debug, Serialize)]
pub struct AppProjectList {
    pub projects: Vec<AppProjectSummary>,
}
