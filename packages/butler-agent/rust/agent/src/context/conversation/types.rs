use crate::conversation::{
    ConversationPartKind, ConversationProviderShape, ConversationRole, ConversationStatus,
    TurnOutcomeCapsule,
};
use serde::Serialize;
use std::sync::Arc;

#[derive(Clone, Debug, PartialEq, Serialize)]
pub(crate) struct ConversationContextPart {
    pub kind: ConversationPartKind,
    pub text: Option<String>,
    pub tool_call_id: Option<String>,
    pub parent_tool_call_id: Option<String>,
    pub provider_shape: Option<ConversationProviderShape>,
    pub status: ConversationStatus,
}

#[derive(Clone, Debug, PartialEq, Serialize)]
pub(crate) struct ConversationContextMessage {
    pub conversation_message_id: String,
    pub turn_id: Option<String>,
    pub seq: u64,
    pub created_at: String,
    pub speaker: &'static str,
    pub role: ConversationRole,
    pub text: String,
    pub parts: Vec<ConversationContextPart>,
}

#[derive(Clone, Debug, PartialEq, Serialize)]
pub(crate) struct ConversationContextSummary {
    pub summary_id: String,
    pub covers_from_seq: f64,
    pub covers_to_seq: f64,
    pub source_hash: String,
    pub text: String,
}

#[derive(Clone, Debug)]
pub(crate) struct PromptMaterialRenderOptions {
    pub max_tokens: f64,
    pub exclude_source_ref: Option<String>,
    pub exclude_turn_id: Option<String>,
    pub include_summaries: Option<bool>,
    pub include_tools: Option<bool>,
    pub current_request: Option<CurrentRequestInput>,
}

#[derive(Clone, Debug)]
pub(crate) struct CurrentRequestInput {
    pub id: String,
    pub text: String,
}

#[derive(Clone, Debug, PartialEq, Serialize)]
pub(crate) struct ConversationCurrentRequestAtom {
    pub id: String,
    pub source_hash: String,
    pub serialized_tokens: usize,
    pub text: String,
}

#[derive(Clone, Debug, PartialEq)]
pub(crate) struct ConversationSemanticTurnAtom {
    pub id: String,
    pub turn_id: Option<String>,
    pub status: String,
    pub source_hash: String,
    pub first_seq: u64,
    pub last_seq: u64,
    pub serialized_tokens: usize,
    pub messages: Vec<ConversationContextMessage>,
    pub outcome: Option<TurnOutcomeCapsule>,
}

#[derive(Clone, Debug, PartialEq, Serialize)]
pub(crate) struct ConversationSummaryAtom {
    pub summary_id: String,
    pub covers_from_seq: f64,
    pub covers_to_seq: f64,
    pub source_hash: String,
    pub text: String,
    pub id: String,
    pub serialized_tokens: usize,
}

#[derive(Clone, Debug, PartialEq)]
pub(crate) struct ConversationPromptContextPlan {
    pub session_id: String,
    pub measurement: &'static str,
    pub capacity_tokens: f64,
    pub current_request: Option<ConversationCurrentRequestAtom>,
    pub required_turns: Vec<Arc<ConversationSemanticTurnAtom>>,
    pub optional_turns: Vec<Arc<ConversationSemanticTurnAtom>>,
    pub selected_optional_turns: Vec<Arc<ConversationSemanticTurnAtom>>,
    pub selected_summaries: Vec<ConversationSummaryAtom>,
    pub selected_atom_ids: Vec<String>,
    pub compiled_input_tokens: usize,
    pub rendered: String,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub(crate) enum ConversationContextDirection {
    Before,
    After,
    Around,
}

#[derive(Clone, Debug)]
pub(crate) struct ValidatedContextLimits {
    pub limit: f64,
    pub max_chars: f64,
}

#[derive(Clone, Debug)]
pub(crate) struct ReadConversationContextInput {
    pub session_id: String,
    pub gateway: Option<String>,
    pub query: Option<String>,
    pub anchor_message_id: Option<String>,
    pub anchor_event_id: Option<String>,
    pub direction: Option<ConversationContextDirection>,
    pub limit: Option<f64>,
    pub max_chars: Option<f64>,
    pub include_tools: bool,
    pub validated_limits: Option<ValidatedContextLimits>,
    pub include_internal: bool,
}

#[derive(Clone, Debug, PartialEq, Serialize)]
pub(crate) struct ConversationContextResult {
    pub ok: bool,
    pub session_id: String,
    pub runtime_session_id: String,
    pub query: Option<String>,
    pub anchor_message_id: Option<String>,
    pub anchor_event_id: Option<String>,
    pub direction: ConversationContextDirection,
    pub returned: usize,
    pub truncated: bool,
    pub messages: Vec<ConversationContextMessage>,
    pub summaries: Vec<ConversationContextSummary>,
}
