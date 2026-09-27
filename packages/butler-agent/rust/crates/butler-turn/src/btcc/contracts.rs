//! Shared serialized BTCC message, result and error contracts.

use super::ExecutionControls;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use tokio_util::sync::CancellationToken;

/// How much reasoning the model is asked to spend.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ReasoningEffort {
    None,
    Low,
    Medium,
    High,
    Xhigh,
    Max,
}

/// What a turn may do to the workspace: anything, ask first, or read only.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum AccessMode {
    FullAccess,
    AskFirst,
    ReadOnly,
}

/// The conversation a message came from on its transport.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Peer {
    pub kind: PeerKind,
    pub id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub parent_id: Option<String>,
}

/// The kind of transport conversation.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum PeerKind {
    Dm,
    Group,
    Thread,
    Channel,
}

/// Who sent an inbound message.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Sender {
    pub id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub display_name: Option<String>,
}

/// An attachment of an inbound message.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AttachmentRef {
    pub id: String,
    pub kind: AttachmentKind,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub mime_type: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub file_name: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub size_bytes: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub url: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub local_path: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub visual_manifest: Option<Value>,
}

/// The media kind of an attachment.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum AttachmentKind {
    Image,
    Audio,
    Video,
    Document,
    Binary,
}

impl AttachmentKind {
    /// The serde (`snake_case`) name.
    pub(crate) fn as_str(&self) -> &'static str {
        match self {
            Self::Image => "image",
            Self::Audio => "audio",
            Self::Video => "video",
            Self::Document => "document",
            Self::Binary => "binary",
        }
    }
}

/// The inbound message that starts a turn.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TurnMessage {
    pub id: String,
    pub content: String,
    pub timestamp: String,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub attachments: Vec<AttachmentRef>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub image_admission: Option<Value>,
}

/// What started a turn: a user message or an authorized wake of an earlier turn.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum TurnTrigger {
    UserMessage,
    AuthorizedWake {
        #[serde(rename = "triggerId")]
        trigger_id: String,
        #[serde(rename = "sourceTurnId")]
        source_turn_id: String,
        #[serde(rename = "authorizationRef")]
        authorization_ref: String,
        #[serde(rename = "resultScopeRef", skip_serializing_if = "Option::is_none")]
        result_scope_ref: Option<String>,
    },
}

/// The role a session plays: the user's butler, a delegated steward or a worker.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum SessionRole {
    Butler,
    Steward,
    Worker,
}

/// Where a turn runs: its role, workspace and project.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TurnRoute {
    pub role: SessionRole,
    pub workspace_path: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub project_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reason: Option<String>,
}

/// Where a turn's progress is published.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProgressDestination {
    pub transport: String,
    pub account_id: String,
    pub peer: Peer,
    pub reply_to_message_id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub app_queue_claim_id: Option<String>,
}

/// A request to run (or replay) one turn.
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TurnRequest {
    pub turn_id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub recovery_attempt: Option<u32>,
    pub session_id: String,
    pub event_id: String,
    pub transport: String,
    pub account_id: String,
    pub peer: Peer,
    pub sender: Sender,
    pub message: TurnMessage,
    pub trigger: TurnTrigger,
    pub route: TurnRoute,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub progress_destination: Option<ProgressDestination>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub execution_controls: Option<ExecutionControls>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub empty_response_policy: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub app_turn_context: Option<Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub authority_request_ref: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub authority_client_message_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub app_queue_claim_id: Option<String>,
    #[serde(skip, default)]
    pub preparation_cancellation: CancellationToken,
}

/// A request to stop a turn.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StopRequest {
    pub turn_id: String,
}

/// Whether the turn was newly admitted or replayed its stored admission.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum AdmissionKind {
    Fresh,
    Replay,
}

/// An operational failure a turn answers with instead of an answer.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
#[derive(thiserror::Error)]
#[error("{code}")]
pub struct RuntimeFailure {
    pub code: String,
    pub retryable: bool,
}

/// A file a turn produced for the user.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FinalArtifact {
    pub id: String,
    pub kind: ArtifactKind,
    pub title: String,
    pub safe_path_label: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub mime_type: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub size_bytes: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub created_at: Option<String>,
}

/// The kind of produced artifact.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ArtifactKind {
    CsvFile,
    TableFile,
    ChartFile,
    Image,
    Document,
    Code,
    Report,
    File,
    Unknown,
}

/// The lifecycle state of durable Work.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum WorkStatus {
    Open,
    Completed,
    Blocked,
    Abandoned,
}

/// How the Work a turn accepted ended.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum AcceptedWorkStatus {
    Success,
    Blocked,
    Failed,
}

/// The accepted Work outcome delivered with a final answer.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct AcceptedWorkResult {
    pub status: AcceptedWorkStatus,
}

/// Why a delivered turn is still executing elsewhere.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ExecutionOutcome {
    WaitingForWorker,
}

/// The model a turn asked for, the one that answered, and what the provider reported.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ModelIdentity {
    pub(crate) requested_model_ref: String,
    pub(crate) effective_model_ref: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) provider_reported_model_ref: Option<String>,
}

/// A turn delivered now.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DeliveredOutcome {
    pub turn_id: String,
    pub message_id: String,
    pub content: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub work_status: Option<WorkStatus>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub accepted_work_result: Option<AcceptedWorkResult>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub runtime_failure: Option<RuntimeFailure>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub execution_outcome: Option<ExecutionOutcome>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub artifacts: Vec<FinalArtifact>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub changed_files: Vec<Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub plan: Option<Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub model_identity: Option<ModelIdentity>,
}

/// A turn that had already been delivered.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AlreadyDeliveredOutcome {
    pub turn_id: String,
    pub message_id: String,
    pub content: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub work_status: Option<WorkStatus>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub accepted_work_result: Option<AcceptedWorkResult>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub runtime_failure: Option<RuntimeFailure>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub execution_outcome: Option<ExecutionOutcome>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub artifacts: Vec<FinalArtifact>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub changed_files: Vec<Value>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(
    tag = "kind",
    rename_all = "snake_case",
    rename_all_fields = "camelCase"
)]
/// How a turn request ended.
pub enum TurnOutcomeKind {
    Delivered(Box<DeliveredOutcome>),
    AlreadyDelivered(Box<AlreadyDeliveredOutcome>),
    Cancelled { turn_id: String },
    AlreadyCancelled { turn_id: String },
    AlreadyFinalizing { turn_id: String },
    FencedPendingPersistence { turn_id: String },
    Suspended { turn_id: String, reason: String },
}

/// The result of a turn request with how it was admitted.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TurnOutcome {
    #[serde(flatten)]
    pub result: TurnOutcomeKind,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub admission: Option<AdmissionKind>,
}
