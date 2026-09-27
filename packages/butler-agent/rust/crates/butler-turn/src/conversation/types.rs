use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};

/// The author of a canonical conversation message.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ConversationRole {
    System,
    Developer,
    User,
    Assistant,
    Tool,
}
/// Who a message is shown to: the model, the user, operators, or only audit links.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ConversationVisibility {
    Model,
    User,
    Operator,
    AuditLink,
}
/// The lifecycle state of a message or part.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ConversationStatus {
    Pending,
    Complete,
    Failed,
    Compacted,
}
/// Where a message came from: live traffic, recovery, import or a synthetic summary.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ConversationProvenance {
    Trusted,
    Recovered,
    Imported,
    SyntheticSummary,
}
/// The kind of content a message part carries.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ConversationPartKind {
    Text,
    AttachmentRef,
    ToolCall,
    ToolResult,
    SummaryRef,
    MessageContent,
}
/// The provider wire shape a tool part was recorded in.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ConversationProviderShape {
    Openai,
    Anthropic,
    Generic,
}
/// Whether a message is user input, public assistant output, internal control or unknown.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ConversationOriginKind {
    UserInput,
    AssistantPublic,
    InternalControl,
    Unknown,
}

/// Field order is persisted: `origin_evidence_json` stores `kind, ref, sha256`
/// (the legacy Bun writer's order) and origin classification compares the
/// stored text byte-for-byte, so do not reorder these fields.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct ConversationOriginEvidence {
    pub kind: String,
    #[serde(rename = "ref")]
    pub reference: String,
    pub sha256: Option<String>,
}
/// A versioned origin classification of a message with its evidence.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ConversationOriginDecision {
    pub kind: ConversationOriginKind,
    pub reference: Option<String>,
    pub reason: String,
    pub version: String,
    pub evidence: Vec<ConversationOriginEvidence>,
    pub complete: bool,
}

/// A canonical conversation session.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ConversationSession {
    pub id: String,
    pub workspace_id: Option<String>,
    pub project_id: Option<String>,
    pub gateway_origin: String,
    pub created_at: String,
    pub updated_at: String,
    pub status: String,
    pub schema_version: u64,
}
/// Maps a gateway's external session to its canonical conversation session.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ConversationBinding {
    pub gateway: String,
    pub external_session_id: String,
    pub conversation_session_id: String,
    pub created_at: String,
}
/// One request/response turn of a session.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ConversationTurn {
    pub id: String,
    pub session_id: String,
    pub seq: u64,
    pub actor: String,
    pub status: String,
    pub request_id: Option<String>,
    pub started_at: String,
    pub completed_at: Option<String>,
}
/// A canonical message without its parts.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ConversationMessage {
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
/// One ordered part of a message (text, attachment, tool call or result).
#[derive(Clone, Debug, PartialEq)]
pub struct ConversationPart {
    pub id: String,
    pub message_id: String,
    pub part_index: u64,
    pub kind: ConversationPartKind,
    // Passthrough: conversation part content keyed by part kind; tool/provider payloads.
    pub content_json: Value,
    pub tool_call_id: Option<String>,
    pub parent_tool_call_id: Option<String>,
    pub provider_shape: Option<ConversationProviderShape>,
    pub status: ConversationStatus,
}
/// A message with its ordered parts.
#[derive(Clone, Debug, PartialEq)]
pub struct ConversationMessageWithParts {
    pub message: ConversationMessage,
    pub parts: Vec<ConversationPart>,
}
/// A page of messages and whether more exist.
#[derive(Clone, Debug, PartialEq)]
pub struct ConversationMessagePage {
    pub messages: Vec<ConversationMessageWithParts>,
    pub has_more: bool,
}
/// A stored summary covering a sequence range of a session.
#[derive(Clone, Debug, PartialEq)]
pub struct ConversationSummary {
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

/// How a turn ended.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum TurnOutcomeKind {
    Delivered,
    Failed,
    Cancelled,
    Recoverable,
}
/// The generation-versioned outcome of a turn, hashed over the messages it references.
#[derive(Clone, Debug, PartialEq)]
pub struct TurnOutcomeCapsule {
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
    // Passthrough: provider payload, opaque to BTCC.
    pub continuation: Option<Map<String, Value>>,
    pub safe_code: Option<String>,
    pub created_at: String,
}
/// The outcome capsule to write; id, generation and time default when absent.
#[derive(Clone, Debug, PartialEq)]
pub struct TurnOutcomeCapsuleInput {
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
    // Passthrough: provider payload, opaque to BTCC.
    pub continuation: Option<Map<String, Value>>,
    pub safe_code: Option<String>,
    pub created_at: Option<String>,
}

/// Starts (or replays) a turn, binding the gateway session to its conversation session.
#[derive(Clone, Debug)]
pub struct BeginTurnInput {
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
/// One part of a message being appended.
#[derive(Clone, Debug, PartialEq)]
pub struct MessagePartInput {
    pub kind: ConversationPartKind,
    // Passthrough: conversation part content keyed by part kind; tool/provider payloads.
    pub content_json: Value,
    pub tool_call_id: Option<String>,
    pub parent_tool_call_id: Option<String>,
    pub provider_shape: Option<ConversationProviderShape>,
    pub status: Option<ConversationStatus>,
}
/// A message to append, with its origin classification and optional parts.
#[derive(Clone, Debug, PartialEq)]
pub struct AppendMessageInput {
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
    // Passthrough: conversation part content keyed by part kind; tool/provider payloads.
    pub content_json: Value,
    pub tool_call_id: String,
    pub parent_tool_call_id: Option<String>,
    pub provider_shape: Option<ConversationProviderShape>,
    pub status: Option<ConversationStatus>,
}
/// Finalizes a turn's status, optionally writing its outcome capsule.
#[derive(Clone, Debug, PartialEq)]
pub struct FinalizeTurnInput {
    pub turn_id: String,
    pub status: Option<String>,
    pub completed_at: Option<String>,
    pub outcome_capsule: Option<TurnOutcomeCapsuleInput>,
}
/// A summary to store for a sequence range.
#[derive(Clone, Debug, PartialEq)]
pub struct ConversationSummaryInput {
    pub session_id: String,
    pub covers_from_seq: f64,
    pub covers_to_seq: f64,
    pub source_hash: String,
    pub summary_text: String,
    pub model: Option<String>,
    pub summary_id: Option<String>,
    pub now: Option<String>,
}

/// Reads a session's latest messages.
#[derive(Clone, Debug)]
pub struct ReadMessagesInput {
    pub session_id: String,
    pub limit: Option<f64>,
    pub include_compacted: bool,
}
/// Which messages around an anchor a read returns.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum AroundDirection {
    Before,
    After,
    Around,
}

impl AroundDirection {
    /// The direction named `value`; any other name reads around the anchor.
    pub fn parse(value: &str) -> Self {
        match value {
            "before" => Self::Before,
            "after" => Self::After,
            _ => Self::Around,
        }
    }
}

/// Reads messages before or after an anchor message.
#[derive(Clone, Debug)]
pub struct ReadAroundInput {
    pub session_id: String,
    pub anchor_message_id: Option<String>,
    pub direction: Option<AroundDirection>,
    pub limit: Option<f64>,
    pub include_compacted: bool,
}
/// Reads messages for memory cognition, filtered by role and time.
#[derive(Clone, Debug, Default)]
pub struct ReadCognitionMessagesInput {
    pub session_id: Option<String>,
    pub roles: Vec<ConversationRole>,
    pub since: Option<String>,
    pub limit: Option<f64>,
    pub offset: Option<f64>,
    pub include_compacted: bool,
    pub order: Option<ConversationReadOrder>,
}

/// Sequence order of a message read.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ConversationReadOrder {
    Asc,
    Desc,
}
/// Message counts of a session.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ConversationMessageStats {
    pub semantic_messages: u64,
    pub compacted_messages: u64,
    pub latest_message_timestamp: Option<String>,
}
/// Summary counts of a session.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ConversationSummaryStats {
    pub summaries: u64,
    pub summary_text_chars: u64,
}
/// Message and summary statistics of a session with a prompt-size estimate.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ConversationStatusStats {
    pub messages: ConversationMessageStats,
    pub summaries: ConversationSummaryStats,
    pub prompt_token_estimate: u64,
}
/// What a prompt is built from: summaries, the semantic tail and the current turn.
#[derive(Clone, Debug, PartialEq)]
pub struct PromptMaterial {
    pub session_id: String,
    pub summaries: Vec<ConversationSummary>,
    pub semantic_tail: Vec<ConversationMessageWithParts>,
    pub current_turn: Vec<ConversationMessageWithParts>,
    pub turns: Vec<ConversationTurn>,
    pub outcomes: Vec<TurnOutcomeCapsule>,
    pub token_estimate: u64,
    pub provenance: Vec<PromptProvenance>,
}

/// Whether prompt content came from a summary or a message.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum PromptProvenanceKind {
    Summary,
    Message,
}

/// The summary or message a piece of prompt content came from.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct PromptProvenance {
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
