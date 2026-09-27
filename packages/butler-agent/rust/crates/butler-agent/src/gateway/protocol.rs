use std::collections::BTreeMap;

use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};

pub(super) const APP_PROTOCOL_VERSION: &str = "butler.app.v1";

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "snake_case")]
pub(crate) enum MessageRole {
    User,
    Assistant,
    System,
    SystemEvent,
    ToolSummary,
    Automation,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "snake_case")]
pub(crate) enum MessageStatus {
    Pending,
    Sent,
    Thinking,
    Streaming,
    Delivered,
    Failed,
    Retrying,
    Cancelled,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "snake_case")]
pub(crate) enum TurnState {
    Queued,
    Accepted,
    Thinking,
    Streaming,
    WaitingForForm,
    WaitingForTool,
    Cancelling,
    Cancelled,
    Delivered,
    RuntimeFault,
    Failed,
    Retrying,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "snake_case")]
pub(crate) enum DeliveryState {
    Running,
    WaitingUser,
    SystemError,
    Cancelled,
    Delivered,
    DeliveredWithLimitations,
    DeliveredWithContinuation,
    FailedSystem,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "snake_case")]
pub(crate) enum MessageFileKind {
    Text,
    Image,
    Generic,
}

#[derive(Clone, Debug)]
pub(crate) struct MessageSendRequest {
    pub expected_project_id: Option<String>,
    pub content_parts: Option<MessageContent>,
    pub chat_id: Option<Value>,
    pub text: Option<Value>,
    pub client_message_id: Option<Value>,
    pub attachments: Option<Value>,
    pub model: Option<Value>,
    pub reasoning_effort: Option<Value>,
    pub access_mode: Option<Value>,
    pub plan_mode: Option<Value>,
    pub subsession_result: Option<crate::btcc::SubsessionResultContext>,
}

#[derive(Clone, Debug)]
pub(crate) struct SessionQueueUpdateRequest {
    pub content_parts: Option<MessageContent>,
    pub text: Option<String>,
    pub plan_id: Option<String>,
    pub attachments: Option<Vec<String>>,
    pub model: Option<String>,
    pub reasoning_effort: Option<String>,
    pub access_mode: Option<String>,
    pub plan_mode: Option<bool>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
pub(crate) struct MessageContent {
    pub version: u8,
    pub parts: Vec<MessageContentPart>,
    #[serde(flatten)]
    pub extra: Map<String, Value>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(tag = "type")]
pub(crate) enum MessageContentPart {
    #[serde(rename = "text")]
    Text {
        text: String,
        #[serde(flatten)]
        extra: Map<String, Value>,
    },
    #[serde(rename = "session_ref")]
    SessionRef {
        #[serde(rename = "sessionId")]
        session_id: String,
        #[serde(rename = "titleSnapshot")]
        title_snapshot: String,
        #[serde(flatten)]
        extra: Map<String, Value>,
    },
    #[serde(rename = "project_source_ref")]
    ProjectSourceRef {
        #[serde(rename = "projectId")]
        project_id: String,
        source: ProjectSourceReference,
        #[serde(rename = "titleSnapshot")]
        title_snapshot: String,
        #[serde(skip_serializing_if = "Option::is_none")]
        topic: Option<String>,
        #[serde(flatten)]
        extra: Map<String, Value>,
    },
}

#[derive(Clone, Debug, Deserialize, Serialize)]
pub(crate) struct ProjectSourceReference {
    pub kind: String,
    pub id: String,
    pub revision: String,
    #[serde(flatten)]
    pub extra: Map<String, Value>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
pub(crate) struct MessageFileRef {
    pub file_id: String,
    pub kind: MessageFileKind,
    pub mime_type: String,
    pub safe_name: String,
    pub size_bytes: u64,
    pub sha256: String,
    pub url: String,
    pub created_at: String,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
pub(crate) struct SessionArtifactSummary {
    pub id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub session_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub project_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub message_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub turn_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub file_id: Option<String>,
    pub kind: ArtifactKind,
    pub title: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub safe_path_label: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub url: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub size_bytes: Option<u64>,
    pub created_at: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub open_action: Option<ArtifactOpenAction>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
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

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "snake_case")]
pub(crate) enum ArtifactOpenAction {
    Route,
    Unsupported,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
pub(crate) struct ChangedFileDetail {
    pub path: String,
    pub additions: u64,
    pub deletions: u64,
    pub lines: Vec<ChangedFileLine>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
pub(crate) struct ChangedFileLine {
    #[serde(rename = "type")]
    pub line_type: ChangedFileLineType,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub old_line: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub new_line: Option<u64>,
    pub content: String,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "snake_case")]
pub(crate) enum ChangedFileLineType {
    Added,
    Deleted,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
pub(crate) struct MessageRecord {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub content_parts: Option<MessageContent>,
    pub id: String,
    pub chat_id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub turn_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub conversation_session_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub conversation_turn_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub conversation_message_id: Option<String>,
    pub role: MessageRole,
    pub text: String,
    pub status: MessageStatus,
    pub created_at: String,
    pub updated_at: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub safe_error_code: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub delivery_state: Option<DeliveryState>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub limitation_codes: Option<Vec<String>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub limitations: Option<Vec<String>>,
    pub retryable: bool,
    pub cursor: u64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub attachments: Option<Vec<MessageFileRef>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub artifacts: Option<Vec<SessionArtifactSummary>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub changed_files: Option<Vec<ChangedFileDetail>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub plan_document: Option<Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub work_blocks: Option<Vec<Value>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub turn_activity_rows: Option<Vec<Value>>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
pub(crate) struct QueuedMessageRecord {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub content_parts: Option<MessageContent>,
    pub id: String,
    pub chat_id: String,
    pub text: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub client_message_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub plan_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub attachments: Option<Vec<MessageFileRef>>,
    pub controls: SessionControlState,
    pub state: QueueState,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub safe_error_code: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub dispatched_message_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub turn_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub terminal_result_message_id: Option<String>,
    pub cursor: u64,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
pub(crate) struct SessionQueueView {
    pub session_id: String,
    pub queued_messages: Vec<QueuedMessageRecord>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
pub(crate) struct SessionControlState {
    pub model: String,
    pub reasoning_effort: String,
    pub access_mode: String,
    pub plan_mode: bool,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "snake_case")]
pub(crate) enum QueueState {
    Queued,
    Dispatching,
    Dispatched,
    Deleted,
    Failed,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
pub(crate) struct TurnRecord {
    pub id: String,
    pub chat_id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub user_message_id: Option<String>,
    pub state: TurnState,
    pub safe_status_label: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub safe_error_code: Option<String>,
    pub retryable: bool,
    pub cancellable: bool,
    pub attempt: u64,
    pub created_at: String,
    pub updated_at: String,
    pub cursor: u64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub execution_controls: Option<Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub execution_model: Option<Value>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
pub(crate) struct MessageSendResult {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub accepted: Option<MessageRecord>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub queued: Option<QueuedMessageRecord>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reply: Option<MessageRecord>,
    pub replies: Vec<MessageRecord>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub turn: Option<TurnRecord>,
    pub next_cursor: u64,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
pub(crate) struct TurnProgressSnapshotView {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub summary_reference: Option<Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub summary: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub updated_at: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub turn_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub state: Option<ProgressState>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub delivery_state: Option<DeliveryState>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub limitations: Option<Vec<String>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub limitation_codes: Option<Vec<String>>,
    pub safe_progress_rows: Vec<Value>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "snake_case")]
pub(crate) enum ProgressState {
    Idle,
    Queued,
    Accepted,
    Thinking,
    Streaming,
    WaitingForForm,
    WaitingForTool,
    Cancelling,
    Cancelled,
    Delivered,
    RuntimeFault,
    Failed,
    Retrying,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
pub(crate) struct MessageListView {
    pub chat_id: String,
    pub messages: Vec<MessageRecord>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub turn_progress: Option<BTreeMap<String, TurnProgressSnapshotView>>,
    pub next_cursor: f64,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
pub(crate) struct TurnListView {
    pub chat_id: String,
    pub turns: Vec<TurnRecord>,
    pub next_cursor: f64,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
pub(crate) struct AppEventEnvelope {
    pub protocol_version: String,
    pub id: u64,
    #[serde(rename = "type")]
    pub event_type: String,
    pub created_at: String,
    pub payload: Map<String, Value>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
pub(crate) struct EventReplayView {
    pub events: Vec<AppEventEnvelope>,
    pub next_cursor: f64,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
pub(crate) struct HealthView {
    pub ok: bool,
    pub service: String,
    pub protocol_version: String,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
pub(crate) struct RuntimeReadinessView {
    pub authenticated_gateway_ready: bool,
    pub btcc_executor_ready: bool,
    pub executor_pid: Option<u32>,
    pub executor_ready_at: Option<String>,
    pub raw_text_included: bool,
}

#[derive(Serialize)]
pub(super) struct ApiEnvelope<T> {
    pub protocol_version: &'static str,
    pub data: T,
}

#[derive(Serialize)]
pub(super) struct ApiErrorEnvelope<'a> {
    pub protocol_version: &'static str,
    pub error: ApiError<'a>,
}

#[derive(Serialize)]
pub(super) struct ApiError<'a> {
    pub code: &'a str,
    pub message: &'a str,
}
