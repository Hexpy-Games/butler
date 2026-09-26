use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};

use super::contracts::{
    AuthorityDecision, ModelRoundMessage, ModelRoundTool, ModelRoundToolCall, ToolError, ToolResult,
};

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct AuthorityLoopContinuation {
    pub request_ref: String,
    pub call_id: String,
    pub messages: Vec<ModelRoundMessage>,
    pub next_item_ordinal: u64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub provider_continuation: Option<Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub instructions: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub stable_provider_cache_prefix: Option<Value>,
    pub model_round_index: u32,
    pub iteration: u32,
    pub empty_response_recovery_used: bool,
    pub tool_results: Vec<ToolResult>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub presentation: Option<GuidedPresentation>,
    pub batch: AuthorityBatch,
    #[serde(flatten)]
    pub extensions: Map<String, Value>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct AuthorityBatch {
    pub tools: Vec<ModelRoundTool>,
    pub calls: Vec<ModelRoundToolCall>,
    pub next_call_index: usize,
    pub results: Vec<ToolResult>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct GuidedPresentation {
    pub source_revision: u64,
    pub activity: GuidedActivitySnapshot,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct GuidedActivitySnapshot {
    pub managed: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub pending_execution_title: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub pending_stage: Option<String>,
    pub tool_bindings: Vec<(String, GuidedActivityBinding)>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub current_activity_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub fallback_activity_id: Option<String>,
    pub groups: Vec<ActivityGroup>,
    pub pending_tools: Vec<PendingTool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub pending_execution: Option<bool>,
    #[serde(flatten)]
    pub extensions: Map<String, Value>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ActivityGroup {
    pub activity_id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub display_stage: Option<String>,
    pub deferred_until_accepted: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub resumes_work: Option<bool>,
    pub title: String,
    pub summary: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub interface_content: Option<Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub rationale: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub next_step: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub starts_execution: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub next_execution_title: Option<String>,
    pub published: bool,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub preceding_ids: Vec<String>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub following_ids: Vec<String>,
    #[serde(flatten)]
    pub extensions: Map<String, Value>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct PendingTool {
    pub name: String,
    pub claimed: bool,
    pub group_id: String,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct GuidedActivityBinding {
    pub activity_id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub display_stage: Option<String>,
    pub deferred_until_accepted: bool,
}

pub(super) fn pending_authority(value: Option<&crate::json::JsonDocument>) -> Option<String> {
    let value = value?;
    (value.field("authority_pending").ok().flatten()? == "true")
        .then(|| value.field("request_ref").ok().flatten())?
        .and_then(|raw| serde_json::from_str(raw).ok())
}

pub(super) fn unexecuted_call(
    call: &ModelRoundToolCall,
    decision: &AuthorityDecision,
    pending: bool,
) -> ToolResult {
    let (decision_name, message) = match decision {
        AuthorityDecision::Deny => (
            "denied",
            "The user denied this operation. It was not executed.",
        ),
        AuthorityDecision::Modify { .. } => (
            "modified",
            "The user requested a change. This operation was not executed.",
        ),
        AuthorityDecision::Allow => unreachable!("allow executes the accepted call"),
    };
    ToolResult {
        tool_call_id: call.id.clone(),
        name: call.name.clone(),
        ok: false,
        error: Some(ToolError {
            code: if pending {
                format!("authority_request_{decision_name}")
            } else {
                "tool_batch_not_executed".into()
            },
            message: if pending {
                message.into()
            } else {
                "Not executed because the user changed or denied an earlier operation in this batch."
                    .into()
            },
            field: None,
        }),
        output: None,
    }
}
