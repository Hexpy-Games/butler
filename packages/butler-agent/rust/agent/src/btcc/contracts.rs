//! Shared serialized BTCC message, result and error contracts.

use super::ExecutionControls;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use tokio_util::sync::CancellationToken;

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub(crate) enum ReasoningEffort {
    None,
    Low,
    Medium,
    High,
    Xhigh,
    Max,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub(crate) enum AccessMode {
    FullAccess,
    AskFirst,
    ReadOnly,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Peer {
    pub(crate) kind: PeerKind,
    pub(crate) id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) parent_id: Option<String>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub(crate) enum PeerKind {
    Dm,
    Group,
    Thread,
    Channel,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Sender {
    pub(crate) id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) display_name: Option<String>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct AttachmentRef {
    pub(crate) id: String,
    pub(crate) kind: AttachmentKind,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) mime_type: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) file_name: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) size_bytes: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) url: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) local_path: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) visual_manifest: Option<Value>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub(crate) enum AttachmentKind {
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

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct TurnMessage {
    pub(crate) id: String,
    pub(crate) content: String,
    pub(crate) timestamp: String,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub(crate) attachments: Vec<AttachmentRef>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) image_admission: Option<Value>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub(crate) enum TurnTrigger {
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

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub(crate) enum SessionRole {
    Butler,
    Steward,
    Worker,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct TurnRoute {
    pub(crate) role: SessionRole,
    pub(crate) workspace_path: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) project_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) reason: Option<String>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ProgressDestination {
    pub(crate) transport: String,
    pub(crate) account_id: String,
    pub(crate) peer: Peer,
    pub(crate) reply_to_message_id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) app_queue_claim_id: Option<String>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct TurnRequest {
    pub(crate) turn_id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) recovery_attempt: Option<u32>,
    pub(crate) session_id: String,
    pub(crate) event_id: String,
    pub(crate) transport: String,
    pub(crate) account_id: String,
    pub(crate) peer: Peer,
    pub(crate) sender: Sender,
    pub(crate) message: TurnMessage,
    pub(crate) trigger: TurnTrigger,
    pub(crate) route: TurnRoute,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) progress_destination: Option<ProgressDestination>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) execution_controls: Option<ExecutionControls>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) empty_response_policy: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) app_turn_context: Option<Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) authority_request_ref: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) authority_client_message_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) app_queue_claim_id: Option<String>,
    #[serde(skip, default)]
    pub(crate) preparation_cancellation: CancellationToken,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct StopRequest {
    pub(crate) turn_id: String,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub(crate) enum AdmissionKind {
    Fresh,
    Replay,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct RuntimeFailure {
    pub(crate) code: String,
    pub(crate) retryable: bool,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct FinalArtifact {
    pub(crate) id: String,
    pub(crate) kind: ArtifactKind,
    pub(crate) title: String,
    pub(crate) safe_path_label: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) mime_type: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) size_bytes: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) created_at: Option<String>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub(crate) enum ArtifactKind {
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

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub(crate) enum WorkStatus {
    Open,
    Completed,
    Blocked,
    Abandoned,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub(crate) enum AcceptedWorkStatus {
    Success,
    Blocked,
    Failed,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub(crate) struct AcceptedWorkResult {
    pub(crate) status: AcceptedWorkStatus,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub(crate) enum ExecutionOutcome {
    WaitingForWorker,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ModelIdentity {
    pub(crate) requested_model_ref: String,
    pub(crate) effective_model_ref: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) provider_reported_model_ref: Option<String>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct DeliveredOutcome {
    pub(crate) turn_id: String,
    pub(crate) message_id: String,
    pub(crate) content: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) work_status: Option<WorkStatus>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) accepted_work_result: Option<AcceptedWorkResult>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) runtime_failure: Option<RuntimeFailure>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) execution_outcome: Option<ExecutionOutcome>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub(crate) artifacts: Vec<FinalArtifact>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub(crate) changed_files: Vec<Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) plan: Option<Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) model_identity: Option<ModelIdentity>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct AlreadyDeliveredOutcome {
    pub(crate) turn_id: String,
    pub(crate) message_id: String,
    pub(crate) content: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) work_status: Option<WorkStatus>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) accepted_work_result: Option<AcceptedWorkResult>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) runtime_failure: Option<RuntimeFailure>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) execution_outcome: Option<ExecutionOutcome>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub(crate) artifacts: Vec<FinalArtifact>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub(crate) changed_files: Vec<Value>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(
    tag = "kind",
    rename_all = "snake_case",
    rename_all_fields = "camelCase"
)]
pub(crate) enum TurnOutcomeKind {
    Delivered(Box<DeliveredOutcome>),
    AlreadyDelivered(Box<AlreadyDeliveredOutcome>),
    Cancelled { turn_id: String },
    AlreadyCancelled { turn_id: String },
    AlreadyFinalizing { turn_id: String },
    FencedPendingPersistence { turn_id: String },
    Suspended { turn_id: String, reason: String },
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct TurnOutcome {
    #[serde(flatten)]
    pub(crate) result: TurnOutcomeKind,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) admission: Option<AdmissionKind>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct BtccError {
    pub(crate) code: String,
    pub(crate) message: String,
}

impl BtccError {
    pub(crate) fn new(code: impl Into<String>, message: impl Into<String>) -> Self {
        Self {
            code: code.into(),
            message: message.into(),
        }
    }
}

impl std::fmt::Display for BtccError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(formatter, "{}: {}", self.code, self.message)
    }
}

impl std::error::Error for BtccError {}

impl From<crate::workspace::WorkspaceError> for BtccError {
    fn from(error: crate::workspace::WorkspaceError) -> Self {
        Self::new(error.code(), error.message())
    }
}

impl From<crate::conversation::ConversationError> for BtccError {
    fn from(error: crate::conversation::ConversationError) -> Self {
        Self::new(error.code(), error.message())
    }
}
