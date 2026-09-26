//! Required Host capabilities used by the App-owned session relocation flow.

use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};

use crate::gateway::ApplicationFuture;

use super::space::AppSpacePosition;

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct AppRelocateSessionRequest {
    pub operation_id: String,
    pub session_id: String,
    pub expected_revision: i64,
    pub target_key: Option<String>,
    pub position: AppSpacePosition,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct AppRelocationBinding {
    pub session_id: String,
    pub role: String,
    pub lifecycle_state: String,
    pub project_id: Option<String>,
    pub app_project_id: Option<String>,
    pub ledger_project_id: Option<String>,
    pub workspace_path: String,
    pub runtime_adapter_id: String,
    pub model_provider_id: String,
    pub model_ref: String,
    pub runtime_session_ref: Option<String>,
    pub provider_thread_ref: Option<String>,
    pub transport_bindings: Vec<AppRelocationTransportBinding>,
    pub created_at: String,
    pub updated_at: String,
    pub last_active_at: Option<String>,
    pub metadata: Option<Map<String, Value>>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct AppRelocationTransportBinding {
    pub transport: String,
    pub account_id: String,
    pub peer_id: String,
    pub thread_id: Option<String>,
}

#[derive(Clone, Debug)]
pub(crate) struct AppRelocationSnapshot {
    pub binding: Option<AppRelocationBinding>,
    pub active_execution: bool,
    pub open_child: bool,
}

#[derive(Clone, Debug)]
pub(crate) struct AppRelocationBindingSeed {
    pub runtime_session_id: String,
    pub project_id: Option<String>,
    pub ledger_project_id: Option<String>,
    pub workspace_path: String,
    pub model_provider_id: String,
    pub model_ref: String,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct AppRelocationWorkspacePlan {
    pub runtime_session_id: String,
    pub operation_id: String,
    pub workspace_path: String,
    pub marker: Option<AppRelocationWorkspaceMarker>,
    pub created: bool,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct AppRelocationWorkspaceMarker {
    pub schema: String,
    pub ownership: String,
    pub repository_anchor_path: String,
    pub branch: String,
    pub bound_at: String,
}

#[derive(Clone, Debug)]
pub(crate) struct AppRelocationWorkspaceRequest {
    pub runtime_session_id: String,
    pub operation_id: String,
    pub project_path: Option<String>,
    pub project_name: Option<String>,
}

#[derive(Clone, Debug)]
pub(crate) struct AppRelocationBindingUpdate {
    pub runtime_session_id: String,
    pub expected_updated_at: String,
    pub operation_id: String,
    pub workspace_path: String,
    pub project_id: Option<String>,
    pub app_project_id: Option<String>,
    pub ledger_project_id: Option<String>,
    pub metadata: Map<String, Value>,
}

#[derive(Clone, Debug)]
pub(crate) enum AppRelocationBindingResult {
    Applied,
    Changed,
    Missing,
}

#[derive(Clone, Debug)]
pub(crate) struct AppRelocationCanonicalUpdate {
    pub runtime_session_id: String,
    pub project_id: Option<String>,
    pub revision: String,
}

pub(crate) trait AppRelocationHost: Send + Sync + 'static {
    fn inspect(&self, runtime_session_id: String) -> ApplicationFuture<AppRelocationSnapshot>;
    fn ensure_binding(
        &self,
        seed: AppRelocationBindingSeed,
    ) -> ApplicationFuture<AppRelocationBinding>;
    fn plan_workspace(
        &self,
        request: AppRelocationWorkspaceRequest,
    ) -> ApplicationFuture<AppRelocationWorkspacePlan>;
    fn prepare_workspace(
        &self,
        plan: AppRelocationWorkspacePlan,
    ) -> ApplicationFuture<AppRelocationWorkspacePlan>;
    fn compare_and_set_binding(
        &self,
        input: AppRelocationBindingUpdate,
    ) -> ApplicationFuture<AppRelocationBindingResult>;
    fn sync_conversation_context(
        &self,
        input: AppRelocationCanonicalUpdate,
    ) -> ApplicationFuture<()>;
    fn discard_workspace(&self, plan: AppRelocationWorkspacePlan) -> ApplicationFuture<bool>;
}
