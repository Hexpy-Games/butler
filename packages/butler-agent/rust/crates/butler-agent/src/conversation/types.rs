use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub(crate) enum ConversationRole {
    System,
    Developer,
    User,
    Assistant,
    Tool,
}
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub(crate) enum ConversationVisibility {
    Model,
    User,
    Operator,
    AuditLink,
}
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub(crate) enum ConversationStatus {
    Pending,
    Complete,
    Failed,
    Compacted,
}
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub(crate) enum ConversationProvenance {
    Trusted,
    Recovered,
    Imported,
    SyntheticSummary,
}
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub(crate) enum ConversationPartKind {
    Text,
    AttachmentRef,
    ToolCall,
    ToolResult,
    SummaryRef,
    MessageContent,
}
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub(crate) enum ConversationProviderShape {
    Openai,
    Anthropic,
    Generic,
}
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub(crate) enum ConversationOriginKind {
    UserInput,
    AssistantPublic,
    InternalControl,
    Unknown,
}

/// Field order is persisted: `origin_evidence_json` stores `kind, ref, sha256`
/// (the legacy Bun writer's order) and origin classification compares the
/// stored text byte-for-byte, so do not reorder these fields.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub(crate) struct ConversationOriginEvidence {
    pub kind: String,
    #[serde(rename = "ref")]
    pub reference: String,
    pub sha256: Option<String>,
}
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct ConversationOriginDecision {
    pub kind: ConversationOriginKind,
    pub reference: Option<String>,
    pub reason: String,
    pub version: String,
    pub evidence: Vec<ConversationOriginEvidence>,
    pub complete: bool,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct ConversationSession {
    pub id: String,
    pub workspace_id: Option<String>,
    pub project_id: Option<String>,
    pub gateway_origin: String,
    pub created_at: String,
    pub updated_at: String,
    pub status: String,
    pub schema_version: u64,
}
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct ConversationBinding {
    pub gateway: String,
    pub external_session_id: String,
    pub conversation_session_id: String,
    pub created_at: String,
}
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct ConversationTurn {
    pub id: String,
    pub session_id: String,
    pub seq: u64,
    pub actor: String,
    pub status: String,
    pub request_id: Option<String>,
    pub started_at: String,
    pub completed_at: Option<String>,
}
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct ConversationMessage {
    pub id: String,
    pub session_id: String,
    pub turn_id: Option<String>,
    pub seq: u64,
    pub role: ConversationRole,
    pub status: ConversationStatus,
    pub visibility: ConversationVisibility,
    pub provenance: ConversationProvenance,
    pub created_at: String,
    pub compacted_by_summary_id: Option<String>,
    pub source_gateway: Option<String>,
    pub source_ref: Option<String>,
    pub origin_kind: ConversationOriginKind,
    pub origin_ref: Option<String>,
    pub origin_reason: Option<String>,
    pub origin_version: Option<String>,
    pub origin_evidence_json: Option<String>,
}
#[derive(Clone, Debug, PartialEq)]
pub(crate) struct ConversationPart {
    pub id: String,
    pub message_id: String,
    pub part_index: u64,
    pub kind: ConversationPartKind,
    pub content_json: Value,
    pub tool_call_id: Option<String>,
    pub parent_tool_call_id: Option<String>,
    pub provider_shape: Option<ConversationProviderShape>,
    pub status: ConversationStatus,
}
#[derive(Clone, Debug, PartialEq)]
pub(crate) struct ConversationMessageWithParts {
    pub message: ConversationMessage,
    pub parts: Vec<ConversationPart>,
}
#[derive(Clone, Debug, PartialEq)]
pub(crate) struct ConversationMessagePage {
    pub messages: Vec<ConversationMessageWithParts>,
    pub has_more: bool,
}
#[derive(Clone, Debug, PartialEq)]
pub(crate) struct ConversationSummary {
    pub id: String,
    pub session_id: String,
    pub covers_from_seq: f64,
    pub covers_to_seq: f64,
    pub source_hash: String,
    pub model: Option<String>,
    pub summary_text: String,
    pub created_at: String,
    pub invalidated_at: Option<String>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub(crate) enum TurnOutcomeKind {
    Delivered,
    Failed,
    Cancelled,
    Recoverable,
}
#[derive(Clone, Debug, PartialEq)]
pub(crate) struct TurnOutcomeCapsule {
    pub id: String,
    pub session_id: String,
    pub turn_id: String,
    pub generation: f64,
    pub outcome: TurnOutcomeKind,
    pub source_hash: String,
    pub request_message_id: Option<String>,
    pub public_assistant_message_id: Option<String>,
    pub provider_id: Option<String>,
    pub model_ref: Option<String>,
    pub evidence_refs: Vec<String>,
    pub unresolved_obligations: Vec<String>,
    pub continuation: Option<Map<String, Value>>,
    pub safe_code: Option<String>,
    pub created_at: String,
}
#[derive(Clone, Debug, PartialEq)]
pub(crate) struct TurnOutcomeCapsuleInput {
    pub id: Option<String>,
    pub session_id: String,
    pub turn_id: String,
    pub generation: f64,
    pub outcome: TurnOutcomeKind,
    pub request_message_id: Option<String>,
    pub public_assistant_message_id: Option<String>,
    pub provider_id: Option<String>,
    pub model_ref: Option<String>,
    pub evidence_refs: Vec<String>,
    pub unresolved_obligations: Vec<String>,
    pub continuation: Option<Map<String, Value>>,
    pub safe_code: Option<String>,
    pub created_at: Option<String>,
}

#[derive(Clone, Debug)]
pub(crate) struct BeginTurnInput {
    pub gateway: String,
    pub external_session_id: String,
    pub session_id: Option<String>,
    pub workspace_id: Option<String>,
    pub project_id: Option<String>,
    pub actor: String,
    pub request_id: Option<String>,
    pub turn_id: Option<String>,
    pub now: Option<String>,
}
#[derive(Clone, Debug, PartialEq)]
pub(crate) struct MessagePartInput {
    pub kind: ConversationPartKind,
    pub content_json: Value,
    pub tool_call_id: Option<String>,
    pub parent_tool_call_id: Option<String>,
    pub provider_shape: Option<ConversationProviderShape>,
    pub status: Option<ConversationStatus>,
}
#[derive(Clone, Debug, PartialEq)]
pub(crate) struct AppendMessageInput {
    pub session_id: String,
    pub turn_id: Option<String>,
    pub text: String,
    pub message_id: Option<String>,
    pub role: ConversationRole,
    pub status: Option<ConversationStatus>,
    pub visibility: Option<ConversationVisibility>,
    pub provenance: Option<ConversationProvenance>,
    pub source_gateway: Option<String>,
    pub source_ref: Option<String>,
    pub origin_kind: Option<ConversationOriginKind>,
    pub origin_ref: Option<String>,
    pub origin_reason: Option<String>,
    pub origin_version: Option<String>,
    pub origin_evidence: Option<Vec<ConversationOriginEvidence>>,
    pub now: Option<String>,
    pub parts: Option<Vec<MessagePartInput>>,
}
#[derive(Clone, Debug, PartialEq)]
pub(crate) struct AppendToolPartInput {
    pub message_id: String,
    pub content_json: Value,
    pub tool_call_id: String,
    pub parent_tool_call_id: Option<String>,
    pub provider_shape: Option<ConversationProviderShape>,
    pub status: Option<ConversationStatus>,
}
#[derive(Clone, Debug, PartialEq)]
pub(crate) struct FinalizeTurnInput {
    pub turn_id: String,
    pub status: Option<String>,
    pub completed_at: Option<String>,
    pub outcome_capsule: Option<TurnOutcomeCapsuleInput>,
}
#[derive(Clone, Debug, PartialEq)]
pub(crate) struct ConversationSummaryInput {
    pub session_id: String,
    pub covers_from_seq: f64,
    pub covers_to_seq: f64,
    pub source_hash: String,
    pub summary_text: String,
    pub model: Option<String>,
    pub summary_id: Option<String>,
    pub now: Option<String>,
}

#[derive(Clone, Debug)]
pub(crate) struct ReadMessagesInput {
    pub session_id: String,
    pub limit: Option<f64>,
    pub include_compacted: bool,
}
#[derive(Clone, Debug)]
pub(crate) struct ReadAroundInput {
    pub session_id: String,
    pub anchor_message_id: Option<String>,
    pub direction: Option<String>,
    pub limit: Option<f64>,
    pub include_compacted: bool,
}
#[derive(Clone, Debug, Default)]
pub(crate) struct ReadCognitionMessagesInput {
    pub session_id: Option<String>,
    pub roles: Vec<ConversationRole>,
    pub since: Option<String>,
    pub limit: Option<f64>,
    pub offset: Option<f64>,
    pub include_compacted: bool,
    pub order: Option<ConversationReadOrder>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum ConversationReadOrder {
    Asc,
    Desc,
}
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct ConversationMessageStats {
    pub semantic_messages: u64,
    pub compacted_messages: u64,
    pub latest_message_timestamp: Option<String>,
}
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct ConversationSummaryStats {
    pub summaries: u64,
    pub summary_text_chars: u64,
}
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct ConversationStatusStats {
    pub messages: ConversationMessageStats,
    pub summaries: ConversationSummaryStats,
    pub prompt_token_estimate: u64,
}
#[derive(Clone, Debug, PartialEq)]
pub(crate) struct PromptMaterial {
    pub session_id: String,
    pub summaries: Vec<ConversationSummary>,
    pub semantic_tail: Vec<ConversationMessageWithParts>,
    pub current_turn: Vec<ConversationMessageWithParts>,
    pub turns: Vec<ConversationTurn>,
    pub outcomes: Vec<TurnOutcomeCapsule>,
    pub token_estimate: u64,
    pub provenance: Vec<PromptProvenance>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum PromptProvenanceKind {
    Summary,
    Message,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct PromptProvenance {
    pub kind: PromptProvenanceKind,
    pub id: String,
}

#[derive(Clone, Debug, PartialEq)]
pub(crate) struct HistoricalOriginCandidate {
    pub message_id: String,
    pub session_id: String,
    pub turn_id: Option<String>,
    pub request_id: Option<String>,
    pub source_gateway: Option<String>,
    pub external_session_id: Option<String>,
    pub source_ref: Option<String>,
    pub provenance: ConversationProvenance,
    pub role: ConversationRole,
    pub origin_kind: ConversationOriginKind,
    pub origin_ref: Option<String>,
    pub origin_reason: Option<String>,
    pub origin_version: Option<String>,
    pub origin_evidence_json: Option<String>,
    pub source_hash: String,
    pub outcome_id: Option<String>,
    pub outcome_generation: Option<f64>,
    pub outcome_request_message_id: Option<String>,
    pub outcome_public_assistant_message_id: Option<String>,
}
#[derive(Clone, Debug)]
pub(crate) struct RecordOriginClassificationInput {
    pub candidate: HistoricalOriginCandidate,
    pub decision: ConversationOriginDecision,
    pub correct_internal_origin: bool,
}
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum RecordOriginClassificationResult {
    Applied,
    Unchanged,
    SourceChanged,
    ClassificationConflict,
}
