//! Sidebar response contracts, mirroring api.ts and shared/canon-contracts.ts.
use super::{ProjectSummary, SpaceView};
use serde::Deserialize;
#[derive(Clone, Deserialize, Default)]
pub(crate) struct SidebarMutationResult {
    pub(crate) space: Option<SpaceView>,
    #[serde(rename = "undoToken")]
    pub(crate) undo_token: Option<String>,
    pub(crate) project: Option<ProjectSummary>,
    pub(crate) session_id: Option<String>,
    pub(crate) id: Option<String>,
}
#[derive(Clone, Deserialize)]
pub(crate) struct ProjectFolderPage {
    pub(crate) root_name: String,
    pub(crate) path: String,
    pub(crate) folders: Vec<ProjectFolder>,
    pub(crate) next_after: Option<String>,
}
#[derive(Clone, Deserialize)]
pub(crate) struct ProjectFolder {
    pub(crate) name: String,
}
#[derive(Clone, Deserialize)]
pub(crate) struct CanonSidebar {
    pub(crate) project_id: String,
    pub(crate) groups: Vec<CanonSidebarGroup>,
}
#[derive(Clone, Deserialize)]
pub(crate) struct CanonSidebarGroup {
    pub(crate) key: String,
    pub(crate) kind: String,
    // Backlog responses omit the title; the screen supplies its localized label.
    #[serde(default)]
    pub(crate) title: String,
    pub(crate) plan_revision: Option<i64>,
    pub(crate) rows: Vec<EpicCard>,
}
#[derive(Clone, Deserialize)]
pub(crate) struct EpicCard {
    pub(crate) id: String,
    pub(crate) project_id: String,
    pub(crate) plan_id: Option<String>,
    pub(crate) home_session_id: Option<String>,
    pub(crate) session_ids: Vec<String>,
    pub(crate) title: String,
    pub(crate) description: String,
    pub(crate) canon_status: String,
    pub(crate) assignee: Option<String>,
    pub(crate) agent: Option<CanonAgent>,
    pub(crate) revision: i64,
    #[serde(default)]
    pub(crate) running: bool,
    pub(crate) queue: Option<EpicQueue>,
}
#[derive(Clone, Deserialize)]
pub(crate) struct CanonAgent {
    pub(crate) person: String,
    pub(crate) via: String,
}

#[derive(Clone, Deserialize)]
pub(crate) struct EpicQueue {
    pub(crate) state: String,
    pub(crate) hold: bool,
    pub(crate) finished_at: Option<i64>,
}

#[derive(Clone, Deserialize)]
pub(crate) struct SidebarUpdateStatus {
    pub(crate) progress: Option<super::UpdateProgressView>,
}

#[derive(Clone, Deserialize)]
pub(crate) struct CanonPlan {
    pub(crate) id: String,
    pub(crate) project_id: String,
    pub(crate) title: String,
    pub(crate) description: String,
    pub(crate) due_on: Option<String>,
    pub(crate) status: String,
    pub(crate) revision: i64,
}
#[derive(Clone, Deserialize)]
pub(crate) struct CanonOverview {
    pub(crate) project_id: String,
    pub(crate) backlog_revision: i64,
    pub(crate) backlog: Vec<EpicCard>,
    pub(crate) plans: Vec<CanonPlan>,
}
