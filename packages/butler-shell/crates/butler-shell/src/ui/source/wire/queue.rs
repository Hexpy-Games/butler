//! Typed renderer wire contracts; field names follow their TypeScript sources.
use crate::ui::source::wire::MessageFileRef;
use serde::Deserialize;

/// TS: packages/butler-app/client/ui/src/app/types.ts:978 SessionQueueView
#[derive(Debug, Clone, PartialEq, Deserialize)]
pub(crate) struct SessionQueueView {
    pub(crate) session_id: String,
    #[serde(default)]
    pub(crate) queued_messages: Vec<QueuedMessageRecord>,
    #[serde(default)]
    pub(crate) paused: Option<bool>,
}

/// TS: packages/butler-app/client/ui/src/app/types.ts:963 QueuedMessageRecord (inline QueuedMessageRecordControls).
#[derive(Debug, Clone, PartialEq, Deserialize)]
pub(crate) struct QueuedMessageRecordControls {
    pub(crate) model: String,
    pub(crate) reasoning_effort: ReasoningEffort,
    pub(crate) access_mode: AccessMode,
    pub(crate) plan_mode: bool,
}

/// TS: packages/butler-app/client/ui/src/app/types.ts:969 QueuedMessageRecord (inline QueuedMessageRecordState).
#[derive(Debug, Clone, PartialEq, Deserialize)]
#[serde(rename_all = "snake_case")]
pub(crate) enum QueuedMessageRecordState {
    #[serde(rename = "queued")]
    Queued,
    #[serde(rename = "failed")]
    Failed,
    #[serde(rename = "dispatching")]
    Dispatching,
    #[serde(rename = "dispatched")]
    Dispatched,
    #[serde(rename = "deleted")]
    Deleted,
    #[serde(other)]
    Unknown,
}

/// TS: packages/butler-app/client/ui/src/app/types.ts:954 QueuedMessageRecord
#[derive(Debug, Clone, PartialEq, Deserialize)]
pub(crate) struct QueuedMessageRecord {
    #[serde(default)]
    pub(crate) content_parts: Option<MessageContent>,
    pub(crate) id: String,
    pub(crate) chat_id: String,
    pub(crate) text: String,
    #[serde(default)]
    pub(crate) client_message_id: Option<String>,
    #[serde(default)]
    pub(crate) plan_id: Option<String>,
    #[serde(default)]
    pub(crate) attachments: Option<Vec<MessageFileRef>>,
    pub(crate) controls: QueuedMessageRecordControls,
    pub(crate) state: QueuedMessageRecordState,
    #[serde(default)]
    pub(crate) safe_error_code: Option<String>,
    #[serde(default)]
    pub(crate) dispatched_message_id: Option<String>,
    #[serde(default)]
    pub(crate) turn_id: Option<String>,
    pub(crate) cursor: i64,
    pub(crate) created_at: String,
    pub(crate) updated_at: String,
}

/// TS: packages/butler-app/client/ui/src/app/types.ts:6 ReasoningEffort
#[derive(Debug, Clone, PartialEq, Deserialize)]
#[serde(rename_all = "snake_case")]
pub(crate) enum ReasoningEffort {
    #[serde(rename = "none")]
    None,
    #[serde(rename = "low")]
    Low,
    #[serde(rename = "medium")]
    Medium,
    #[serde(rename = "high")]
    High,
    #[serde(rename = "xhigh")]
    Xhigh,
    #[serde(rename = "max")]
    Max,
    #[serde(other)]
    Unknown,
}

/// TS: packages/butler-app/client/ui/src/app/types.ts:8 AccessMode
#[derive(Debug, Clone, PartialEq, Deserialize)]
#[serde(rename_all = "snake_case")]
pub(crate) enum AccessMode {
    #[serde(rename = "read_only")]
    ReadOnly,
    #[serde(rename = "ask_first")]
    AskFirst,
    #[serde(rename = "ask_except_reads")]
    AskExceptReads,
    #[serde(rename = "auto")]
    Auto,
    #[serde(rename = "full_access")]
    FullAccess,
    #[serde(other)]
    Unknown,
}

/// TS: packages/butler-app/client/shared/message-session-contracts.ts:77 MessageContent
#[derive(Debug, Clone, PartialEq, Deserialize)]
pub(crate) struct MessageContent {
    pub(crate) version: i64,
    #[serde(default)]
    pub(crate) parts: Vec<MessageContentPart>,
    #[serde(default)]
    pub(crate) attachment_metadata: Option<serde_json::Value>,
}

/// TS: packages/butler-app/client/shared/message-session-contracts.ts:64 MessageContentPart
#[derive(Debug, Clone, PartialEq, Deserialize)]
#[serde(tag = "type")]
pub(crate) enum MessageContentPart {
    #[serde(rename = "text")]
    Text { text: String },
    #[serde(rename = "session_ref")]
    SessionRef {
        sessionId: String,
        titleSnapshot: String,
    },
    #[serde(rename = "project_ref")]
    ProjectRef {
        projectId: String,
        titleSnapshot: String,
    },
    #[serde(rename = "project_source_ref")]
    ProjectSourceRef {
        projectId: String,
        source: ProjectSourceReference,
        titleSnapshot: String,
        #[serde(default)]
        topic: Option<String>,
    },
}

/// TS: packages/butler-app/client/shared/message-session-contracts.ts:71 ProjectReferenceContentPart
#[derive(Debug, Clone, PartialEq, Deserialize)]
pub(crate) struct ProjectReferenceContentPart {
    pub(crate) r#type: String,
    pub(crate) projectId: String,
    pub(crate) titleSnapshot: String,
}

/// TS: packages/butler-app/client/shared/message-session-contracts.ts:55 ProjectSourceContentPart
#[derive(Debug, Clone, PartialEq, Deserialize)]
pub(crate) struct ProjectSourceContentPart {
    pub(crate) r#type: String,
    pub(crate) projectId: String,
    pub(crate) source: ProjectSourceReference,
    pub(crate) titleSnapshot: String,
    #[serde(default)]
    pub(crate) topic: Option<String>,
}

/// TS: packages/butler-app/client/shared/message-session-contracts.ts:50 ProjectSourceReference (inline ProjectSourceReferenceKind).
#[derive(Debug, Clone, PartialEq, Deserialize)]
#[serde(rename_all = "snake_case")]
pub(crate) enum ProjectSourceReferenceKind {
    #[serde(rename = "plan")]
    Plan,
    #[serde(rename = "task")]
    Task,
    #[serde(rename = "spec")]
    Spec,
    #[serde(rename = "report")]
    Report,
    #[serde(rename = "reference")]
    Reference,
    #[serde(rename = "message")]
    Message,
    #[serde(rename = "work")]
    Work,
    #[serde(other)]
    Unknown,
}

/// TS: packages/butler-app/client/shared/message-session-contracts.ts:49 ProjectSourceReference
#[derive(Debug, Clone, PartialEq, Deserialize)]
pub(crate) struct ProjectSourceReference {
    pub(crate) kind: ProjectSourceReferenceKind,
    pub(crate) id: String,
    pub(crate) revision: String,
}
