use serde::{Deserialize, Serialize};
use serde_json::Value;
use tokio_util::sync::CancellationToken;

use crate::gateway::{ApplicationFuture, GatewayApplicationError};

#[derive(Clone, Copy, Debug, Deserialize, Serialize, Eq, PartialEq)]
#[serde(rename_all = "snake_case")]
pub(crate) enum AppChatKind {
    Chat,
    Project,
}

impl AppChatKind {
    pub(crate) fn as_str(self) -> &'static str {
        match self {
            Self::Chat => "chat",
            Self::Project => "project",
        }
    }
}

#[derive(Clone, Debug)]
pub(crate) struct AppCreateSessionInput {
    pub kind: AppChatKind,
    pub title: Option<String>,
    pub project_id: Option<String>,
    pub session_hint: Option<String>,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) enum AppWorkspaceMode {
    Local,
    Worktree,
}

#[derive(Clone, Debug)]
pub(crate) struct AppCreateSessionRequest {
    pub input: AppCreateSessionInput,
    pub workspace_mode: AppWorkspaceMode,
}

#[derive(Clone, Debug, Serialize)]
pub(crate) struct AppCreateSessionResult {
    pub session: AppSessionSummary,
}

pub(crate) struct AppSessionWorkspaceSnapshot {
    pub session_id: String,
    pub runtime_session_id: String,
    pub project_id: String,
    pub display_name: String,
    pub workspace_path: String,
    pub ledger_project_id: Option<String>,
    pub model: String,
    pub reasoning_effort: String,
    pub access_mode: String,
    pub plan_mode: bool,
}

pub(crate) struct AppSessionBranchQuery {
    pub runtime_session_id: String,
    pub project_workspace_path: Option<String>,
}

pub(crate) trait AppSessionWorkspaceProvisioner: Send + Sync + 'static {
    fn provision(
        &self,
        snapshot: AppSessionWorkspaceSnapshot,
        server_shutdown: CancellationToken,
    ) -> ApplicationFuture<()>;
    fn branch_info(
        &self,
        _query: AppSessionBranchQuery,
        _cancellation: CancellationToken,
    ) -> ApplicationFuture<Value> {
        Box::pin(async { Err(GatewayApplicationError::Internal) })
    }
}

pub(crate) trait AppSessionWorkProgress: Send + Sync + 'static {
    fn read(&self, runtime_session_id: String) -> ApplicationFuture<Option<AppWorkProgress>>;
}

pub(crate) struct AppWorkStreamQuery {
    pub app_session_id: String,
    pub runtime_session_id: String,
    pub current_turn_id: Option<String>,
}

#[derive(Clone, Debug)]
pub(crate) struct AppWorkStreamTurnOutcome {
    pub session_id: String,
    pub turn_id: String,
    pub outcome: String,
    pub status_note: String,
}

pub(crate) trait AppWorkStreamReader: Send + Sync + 'static {
    fn list_active(&self, query: AppWorkStreamQuery) -> ApplicationFuture<Value>;
    fn reconcile_turn(&self, outcome: AppWorkStreamTurnOutcome) -> ApplicationFuture<()>;
}

#[derive(Clone, Debug, Serialize)]
pub(crate) struct AppChatSummary {
    pub id: String,
    pub title: String,
    pub kind: AppChatKind,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub project_id: Option<String>,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Clone, Debug, Serialize)]
pub(crate) struct AppSessionSummary {
    #[serde(skip)]
    pub latest_turn_id: Option<String>,
    pub skills_used: Vec<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub work_progress: Option<AppWorkProgress>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub branch_seed: Option<Value>,
    pub id: String,
    pub kind: AppChatKind,
    pub title: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub project_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub project: Option<AppSessionProject>,
    pub session_hint: String,
    pub created_at: String,
    pub updated_at: String,
    pub last_activity_at: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub last_message_preview: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub active_turn_state: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub safe_status_label: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub safe_status_label_key: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub safe_status_label_parameters: Option<Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub safe_status_content: Option<Value>,
    pub unread_count: u64,
    pub pinned: bool,
    pub archived: bool,
    pub automation_target_count: u64,
}

#[derive(Clone, Debug, Serialize)]
pub(crate) struct AppWorkProgress {
    pub completed: usize,
    pub total: usize,
}

#[derive(Clone, Debug, Serialize)]
pub(crate) struct AppSessionProject {
    pub id: String,
    pub display_name: String,
}
