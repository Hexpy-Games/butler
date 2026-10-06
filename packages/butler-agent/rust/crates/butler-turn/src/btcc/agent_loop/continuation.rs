use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};

use super::contracts::{
    AuthorityDecision, ModelRoundMessage, ModelRoundTool, ModelRoundToolCall, ToolError, ToolResult,
};

/// The loop state persisted while a turn waits for an authority decision
/// (`btcc_turns.authority_continuation_json`); resuming restores it exactly.
///
/// Provider continuation and stable cache prefix are provider passthrough JSON.
/// `extensions` keeps unknown fields so newer writers round-trip.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AuthorityLoopContinuation {
    pub request_ref: String,
    pub call_id: String,
    pub messages: Vec<ModelRoundMessage>,
    pub next_item_ordinal: u64,
    #[serde(skip_serializing_if = "Option::is_none")]
    // Passthrough: provider payload, opaque to BTCC.
    pub provider_continuation: Option<Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub instructions: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    // Passthrough: provider payload, opaque to BTCC.
    pub stable_provider_cache_prefix: Option<Value>,
    pub model_round_index: u32,
    pub iteration: u32,
    pub empty_response_recovery_used: bool,
    #[serde(default, skip_serializing_if = "zero_continuations")]
    pub automatic_continuations: u32,
    /// A Stop hook previously requested continuation in this turn.
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub stop_hook_active: bool,
    #[serde(default, skip_serializing_if = "std::collections::BTreeMap::is_empty")]
    pub feedback_counts: std::collections::BTreeMap<String, u64>,
    pub tool_results: Vec<ToolResult>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub presentation: Option<GuidedPresentation>,
    pub batch: AuthorityBatch,
    #[serde(flatten)]
    // Passthrough: unknown fields kept for forward compatibility.
    pub extensions: Map<String, Value>,
}

#[cfg(any(test, feature = "test-support"))]
impl AuthorityLoopContinuation {
    /// An empty continuation parked on `call_id` of `request_ref` (fixtures).
    pub fn fixture(request_ref: &str, call_id: &str) -> Self {
        Self {
            request_ref: request_ref.into(),
            call_id: call_id.into(),
            messages: Vec::new(),
            next_item_ordinal: 0,
            provider_continuation: None,
            instructions: None,
            stable_provider_cache_prefix: None,
            model_round_index: 0,
            iteration: 0,
            empty_response_recovery_used: false,
            automatic_continuations: 0,
            stop_hook_active: false,
            feedback_counts: Default::default(),
            tool_results: Vec::new(),
            presentation: None,
            batch: AuthorityBatch::default(),
            extensions: Map::new(),
        }
    }

    /// The fixture with a presentation at `source_revision`.
    #[must_use]
    pub fn with_source_revision(mut self, source_revision: u64) -> Self {
        self.presentation = Some(GuidedPresentation {
            source_revision,
            activity: GuidedActivitySnapshot::default(),
        });
        self
    }
}

/// The tool batch interrupted by the authority request, with the cursor of the pending call.
#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AuthorityBatch {
    pub tools: Vec<ModelRoundTool>,
    pub calls: Vec<ModelRoundToolCall>,
    pub next_call_index: usize,
    pub results: Vec<ToolResult>,
}

/// The guided activity presentation at suspension, restored on resume so the
/// user sees the same activity state.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GuidedPresentation {
    pub source_revision: u64,
    pub activity: GuidedActivitySnapshot,
}

/// Snapshot of guided activity grouping: which tool calls belong to which activity.
#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GuidedActivitySnapshot {
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
    // Passthrough: unknown fields kept for forward compatibility.
    pub extensions: Map<String, Value>,
}

/// One user-visible activity and its presentation text.
///
/// `interface_content` is UI passthrough JSON rendered by the client.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ActivityGroup {
    pub activity_id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub display_stage: Option<String>,
    pub deferred_until_accepted: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub resumes_work: Option<bool>,
    pub title: String,
    pub summary: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    // Passthrough: UI content rendered by the client.
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
    // Passthrough: unknown fields kept for forward compatibility.
    pub extensions: Map<String, Value>,
}

/// A tool announced for an activity that has not been claimed by a call yet.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PendingTool {
    pub name: String,
    pub claimed: bool,
    pub group_id: String,
}

/// The activity a tool call is shown under.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GuidedActivityBinding {
    pub activity_id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub display_stage: Option<String>,
    pub deferred_until_accepted: bool,
}

/// The request ref of a tool output that parked the call on an authority request.
pub(super) fn pending_authority(value: Option<&butler_core::json::JsonDocument>) -> Option<String> {
    let value = value?;
    (value.field("authority_pending").ok().flatten()? == "true")
        .then(|| value.field("request_ref").ok().flatten())?
        .and_then(|raw| serde_json::from_str(raw).ok())
}

/// An authority decision that stops the rest of a resumed batch.
#[derive(Clone, Copy)]
pub(super) enum Refusal {
    Denied,
    Modified,
}

impl Refusal {
    /// `Allow` executes the accepted call, so it is not a refusal.
    pub(super) fn from_decision(decision: Option<&AuthorityDecision>) -> Option<Self> {
        match decision? {
            AuthorityDecision::Allow => None,
            AuthorityDecision::Deny => Some(Self::Denied),
            AuthorityDecision::Modify { .. } => Some(Self::Modified),
        }
    }
}

/// Where a refused call sits in the resumed batch.
#[derive(Clone, Copy, PartialEq, Eq)]
pub(super) enum RefusedCall {
    /// The call the authority request was about.
    Pending,
    /// A later call of the same batch, skipped because of the refusal.
    Following,
}

/// The tool result recorded for a call the user's decision kept from running.
pub(super) fn unexecuted_call(
    call: &ModelRoundToolCall,
    refusal: Refusal,
    position: RefusedCall,
) -> ToolResult {
    let pending = position == RefusedCall::Pending;
    let (decision_name, message) = match refusal {
        Refusal::Denied => (
            "denied",
            "The user denied this operation. It was not executed.",
        ),
        Refusal::Modified => (
            "modified",
            "The user requested a change. This operation was not executed.",
        ),
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

#[expect(
    clippy::trivially_copy_pass_by_ref,
    reason = "serde skip_serializing_if borrows its field"
)]
fn zero_continuations(count: &u32) -> bool {
    *count == 0
}
