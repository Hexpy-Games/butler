use butler_turn::btcc::AccessMode;
use serde::{Deserialize, Serialize};
use serde_json::Value;

#[derive(Clone, Debug, Deserialize)]
pub struct CreateAutomationRequest {
    pub id: Option<String>,
    pub title: String,
    pub prompt_body: String,
    pub target_session_id: String,
    pub interval_seconds: i64,
    pub schedule_type: Option<String>,
    pub run_at: Option<String>,
    pub start_at: Option<String>,
    /// The access the schedule's runs get; the target conversation's
    /// current access mode when omitted.
    pub access_mode: Option<AccessMode>,
}

#[derive(Clone, Debug, Default, Deserialize)]
pub struct UpdateAutomationRequest {
    pub title: Option<String>,
    pub prompt_body: Option<String>,
    pub target_session_id: Option<String>,
    pub interval_seconds: Option<i64>,
    pub schedule_type: Option<String>,
    pub run_at: Option<String>,
    pub start_at: Option<String>,
    pub state: Option<String>,
    /// Replaces the access the schedule's runs get.
    pub access_mode: Option<AccessMode>,
}

#[derive(Clone, Debug, Serialize)]
pub struct AutomationSummary {
    pub id: String,
    pub title: String,
    pub state: String,
    pub target_kind: String,
    pub target_session_id: String,
    pub target_label: String,
    pub interval_seconds: i64,
    pub schedule_type: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub run_at: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub start_at: Option<String>,
    pub interval_label: String,
    /// The access the schedule's runs get, whatever the target conversation's mode.
    pub access_mode: AccessMode,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub next_run_at: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub last_run_at: Option<String>,
    pub last_run_state: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub last_safe_error_code: Option<String>,
    pub run_count: i64,
    pub consecutive_failure_count: i64,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Clone, Debug, Serialize)]
pub struct AutomationDetail {
    #[serde(flatten)]
    pub summary: AutomationSummary,
    pub prompt_body: String,
}
#[derive(Clone, Debug, Serialize)]
pub struct AutomationListView {
    pub automations: Vec<AutomationSummary>,
}
#[derive(Clone, Debug, Serialize)]
pub struct AutomationDetailView {
    pub automation: AutomationDetail,
}
#[derive(Clone, Debug, Serialize)]
pub struct AutomationMutationResult {
    pub automation: Value,
}
#[derive(Clone, Debug, Serialize)]
pub struct AutomationRunSummary {
    pub id: String,
    pub automation_id: String,
    pub target_session_id: String,
    pub state: String,
    pub trigger: String,
    pub started_at: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub completed_at: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub safe_error_code: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub queued_message_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub turn_id: Option<String>,
}
#[derive(Clone, Debug, Serialize)]
pub struct AutomationRunListView {
    pub runs: Vec<AutomationRunSummary>,
}
#[derive(Clone, Debug, Serialize)]
pub struct AutomationRunResult {
    pub automation: AutomationSummary,
    pub run: AutomationRunSummary,
}
