//! Sidebar response contracts, mirroring api.ts and shared/canon-contracts.ts (the canon
//! entities themselves are in `canon.rs`).
use super::{EpicCard, ProjectSummary, SpaceView};
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
#[derive(Debug, Clone, PartialEq, Deserialize)]
pub(crate) struct CanonSidebar {
    pub(crate) project_id: String,
    pub(crate) groups: Vec<CanonSidebarGroup>,
}
#[derive(Debug, Clone, PartialEq, Deserialize)]
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
pub(crate) struct SidebarUpdateStatus {
    pub(crate) progress: Option<super::UpdateProgressView>,
}
