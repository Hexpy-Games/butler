use serde::{Deserialize, Serialize};

use super::super::sessions::AppSessionSummary;

#[derive(Clone, Debug, Deserialize)]
pub(crate) struct AppStartTopicConversationRequest {
    pub request_id: String,
    pub current_session_id: Option<String>,
    pub source_session_id: Option<String>,
    pub source_message_id: Option<String>,
    pub title: String,
    pub destination: String,
    pub project_id: Option<String>,
    pub follow_up: Option<serde_json::Value>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(
    tag = "kind",
    rename_all = "snake_case",
    rename_all_fields = "camelCase"
)]
pub(crate) enum AppSessionBranchDestination {
    Chat,
    Project { project_id: String },
    NewProject { name: String },
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct AppSessionBranchRequest {
    pub request_id: String,
    pub source_session_id: String,
    pub source_message_id: String,
    pub title: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub follow_up: Option<String>,
    pub destination: AppSessionBranchDestination,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct AppSessionBranchSeed {
    pub summary: String,
    pub source_session_id: String,
    pub source_message_id: String,
    pub canonical_session_id: Option<String>,
    pub canonical_message_id: Option<String>,
    pub source_through_message_id: String,
    pub excerpt_truncated: bool,
}

#[derive(Clone, Debug)]
pub(crate) struct AppSessionBranchResult {
    pub session: AppSessionSummary,
    pub seed: AppSessionBranchSeed,
}
