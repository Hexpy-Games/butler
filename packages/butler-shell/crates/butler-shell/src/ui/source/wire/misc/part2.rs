//! Typed renderer wire contracts; field names follow their TypeScript sources.
use crate::ui::source::wire::TaskGraphNodeReasonCode;
use serde::Deserialize;

/// TS: packages/butler-app/client/shared/task-graph-contracts.ts:38 TaskGraphNode
#[derive(Debug, Clone, PartialEq, Deserialize)]
pub(crate) struct TaskGraphNode {
    pub(crate) task_id: String,
    pub(crate) title: String,
    pub(crate) status: TaskGraphStatus,
    pub(crate) kind: String,
    pub(crate) rank: i64,
    #[serde(default)]
    pub(crate) assignee_ordinal: Option<i64>,
    #[serde(default)]
    pub(crate) model_display_name: Option<String>,
    #[serde(default)]
    pub(crate) session_id: Option<String>,
    #[serde(default)]
    pub(crate) started_at: Option<String>,
    #[serde(default)]
    pub(crate) finished_at: Option<String>,
    #[serde(default)]
    pub(crate) current_step: Option<String>,
    #[serde(default)]
    pub(crate) blocked_reason: Option<String>,
    #[serde(default)]
    pub(crate) reason_code: Option<TaskGraphNodeReasonCode>,
    pub(crate) handled_directly: bool,
    #[serde(default)]
    pub(crate) attempts: Vec<TaskGraphAttempt>,
    #[serde(default)]
    pub(crate) review: Option<TaskGraphReview>,
    pub(crate) document: TaskDocumentRef,
}

/// TS: packages/butler-app/client/shared/task-graph-contracts.ts:21 TaskGraphPhase
#[derive(Debug, Clone, PartialEq, Deserialize)]
#[serde(rename_all = "snake_case")]
pub(crate) enum TaskGraphPhase {
    #[serde(rename = "conception")]
    Conception,
    #[serde(rename = "planning")]
    Planning,
    #[serde(rename = "execution")]
    Execution,
    #[serde(rename = "review")]
    Review,
    #[serde(rename = "validation")]
    Validation,
    #[serde(rename = "reporting")]
    Reporting,
    #[serde(other)]
    Unknown,
}

/// TS: packages/butler-app/client/shared/task-graph-contracts.ts:4 TaskGraphState
#[derive(Debug, Clone, PartialEq, Deserialize)]
#[serde(rename_all = "snake_case")]
pub(crate) enum TaskGraphState {
    #[serde(rename = "cancelled")]
    Cancelled,
    #[serde(rename = "failed")]
    Failed,
    #[serde(rename = "running")]
    Running,
    #[serde(rename = "waiting")]
    Waiting,
    #[serde(rename = "done")]
    Done,
    #[serde(other)]
    Unknown,
}

/// TS: packages/butler-app/client/shared/task-graph-contracts.ts:5 TaskGraphCounts
#[derive(Debug, Clone, PartialEq, Deserialize)]
pub(crate) struct TaskGraphCounts {
    pub(crate) total: i64,
    pub(crate) completed: i64,
    pub(crate) running: i64,
    pub(crate) failed: i64,
    pub(crate) blocked: i64,
    pub(crate) cancelled: i64,
    pub(crate) skipped: i64,
}

/// TS: packages/butler-app/client/shared/dashboard-space-contracts.ts:240 ProjectDashboardDocument (inline ProjectDashboardDocumentKind).
#[derive(Debug, Clone, PartialEq, Deserialize)]
#[serde(rename_all = "snake_case")]
pub(crate) enum ProjectDashboardDocumentKind {
    #[serde(rename = "plan")]
    Plan,
    #[serde(rename = "spec")]
    Spec,
    #[serde(rename = "report")]
    Report,
    #[serde(other)]
    Unknown,
}

/// TS: packages/butler-app/client/shared/dashboard-space-contracts.ts:232 ProjectDashboardDocument
#[derive(Debug, Clone, PartialEq, Deserialize)]
pub(crate) struct ProjectDashboardDocument {
    #[serde(default)]
    pub(crate) artifact: Option<SharedSessionArtifactSummary>,
    #[serde(default)]
    pub(crate) unavailable: Option<bool>,
    #[serde(default)]
    pub(crate) revision: Option<String>,
    #[serde(default)]
    pub(crate) project_id: Option<String>,
    #[serde(default)]
    pub(crate) truncated: Option<bool>,
    #[serde(default)]
    pub(crate) nextCursor: Option<String>,
    pub(crate) id: String,
    pub(crate) kind: ProjectDashboardDocumentKind,
    #[serde(default)]
    pub(crate) document_type: Option<ProjectDashboardDocumentType>,
    pub(crate) title: String,
    #[serde(default)]
    pub(crate) category: Option<String>,
    #[serde(default)]
    pub(crate) status: Option<String>,
    pub(crate) safe_path_label: String,
    pub(crate) markdown: String,
    pub(crate) updated_at: String,
}

/// TS: packages/butler-app/client/shared/message-session-contracts.ts:203 SessionArtifactSummary (inline SharedSessionArtifactSummaryKind).
#[derive(Debug, Clone, PartialEq, Deserialize)]
#[serde(rename_all = "snake_case")]
pub(crate) enum SharedSessionArtifactSummaryKind {
    #[serde(rename = "image")]
    Image,
    #[serde(rename = "report")]
    Report,
    #[serde(rename = "csv_file")]
    CsvFile,
    #[serde(rename = "table_file")]
    TableFile,
    #[serde(rename = "chart_file")]
    ChartFile,
    #[serde(rename = "document")]
    Document,
    #[serde(rename = "code")]
    Code,
    #[serde(rename = "file")]
    File,
    #[serde(other)]
    Unknown,
}

/// TS: packages/butler-app/client/shared/message-session-contracts.ts:218 SessionArtifactSummary (inline SharedSessionArtifactSummaryOpenAction).
#[derive(Debug, Clone, PartialEq, Deserialize)]
#[serde(rename_all = "snake_case")]
pub(crate) enum SharedSessionArtifactSummaryOpenAction {
    #[serde(rename = "route")]
    Route,
    #[serde(rename = "unsupported")]
    Unsupported,
    #[serde(other)]
    Unknown,
}

/// TS: packages/butler-app/client/shared/message-session-contracts.ts:194 SessionArtifactSummary
#[derive(Debug, Clone, PartialEq, Deserialize)]
pub(crate) struct SharedSessionArtifactSummary {
    #[serde(default)]
    pub(crate) sha256: Option<String>,
    pub(crate) id: String,
    #[serde(default)]
    pub(crate) session_id: Option<String>,
    #[serde(default)]
    pub(crate) project_id: Option<String>,
    #[serde(default)]
    pub(crate) message_id: Option<String>,
    #[serde(default)]
    pub(crate) turn_id: Option<String>,
    #[serde(default)]
    pub(crate) file_id: Option<String>,
    pub(crate) kind: SharedSessionArtifactSummaryKind,
    pub(crate) title: String,
    #[serde(default)]
    pub(crate) safe_path_label: Option<String>,
    #[serde(default)]
    pub(crate) url: Option<String>,
    #[serde(default)]
    pub(crate) size_bytes: Option<i64>,
    pub(crate) created_at: String,
    #[serde(default)]
    pub(crate) open_action: Option<SharedSessionArtifactSummaryOpenAction>,
}

/// TS: packages/butler-app/client/shared/task-graph-contracts.ts:3 TaskGraphStatus
#[derive(Debug, Clone, PartialEq, Deserialize)]
#[serde(rename_all = "snake_case")]
pub(crate) enum TaskGraphStatus {
    #[serde(rename = "cancelled")]
    Cancelled,
    #[serde(rename = "failed")]
    Failed,
    #[serde(rename = "running")]
    Running,
    #[serde(rename = "review")]
    Review,
    #[serde(rename = "blocked")]
    Blocked,
    #[serde(rename = "done")]
    Done,
    #[serde(rename = "pending")]
    Pending,
    #[serde(rename = "paused")]
    Paused,
    #[serde(rename = "skipped")]
    Skipped,
    #[serde(other)]
    Unknown,
}

/// TS: packages/butler-app/client/shared/task-graph-contracts.ts:32 TaskGraphAttempt (inline TaskGraphAttemptStatus).
#[derive(Debug, Clone, PartialEq, Deserialize)]
#[serde(rename_all = "snake_case")]
pub(crate) enum TaskGraphAttemptStatus {
    #[serde(rename = "cancelled")]
    Cancelled,
    #[serde(rename = "failed")]
    Failed,
    #[serde(rename = "success")]
    Success,
    #[serde(rename = "running")]
    Running,
    #[serde(rename = "blocked")]
    Blocked,
    #[serde(rename = "pending")]
    Pending,
    #[serde(other)]
    Unknown,
}

/// TS: packages/butler-app/client/shared/task-graph-contracts.ts:28 TaskGraphAttempt
#[derive(Debug, Clone, PartialEq, Deserialize)]
pub(crate) struct TaskGraphAttempt {
    pub(crate) task_id: String,
    pub(crate) session_id: String,
    pub(crate) ordinal: i64,
    pub(crate) status: TaskGraphAttemptStatus,
    #[serde(default)]
    pub(crate) summary: Option<String>,
    #[serde(default)]
    pub(crate) model_display_name: Option<String>,
    #[serde(default)]
    pub(crate) started_at: Option<String>,
    #[serde(default)]
    pub(crate) finished_at: Option<String>,
}

/// TS: packages/butler-app/client/shared/task-graph-contracts.ts:23 TaskGraphReview (inline TaskGraphReviewSubject).
#[derive(Debug, Clone, PartialEq, Deserialize)]
#[serde(rename_all = "snake_case")]
pub(crate) enum TaskGraphReviewSubject {
    #[serde(rename = "plan")]
    Plan,
    #[serde(rename = "result")]
    Result,
    #[serde(rename = "completion")]
    Completion,
    #[serde(other)]
    Unknown,
}

/// TS: packages/butler-app/client/shared/task-graph-contracts.ts:24 TaskGraphReview (inline TaskGraphReviewVerdict).
#[derive(Debug, Clone, PartialEq, Deserialize)]
#[serde(rename_all = "snake_case")]
pub(crate) enum TaskGraphReviewVerdict {
    #[serde(rename = "accept")]
    Accept,
    #[serde(rename = "revise")]
    Revise,
    #[serde(rename = "partial")]
    Partial,
    #[serde(other)]
    Unknown,
}

/// TS: packages/butler-app/client/shared/task-graph-contracts.ts:22 TaskGraphReview
#[derive(Debug, Clone, PartialEq, Deserialize)]
pub(crate) struct TaskGraphReview {
    pub(crate) subject: TaskGraphReviewSubject,
    pub(crate) verdict: TaskGraphReviewVerdict,
    pub(crate) summary: String,
    pub(crate) created_at: String,
}

/// TS: packages/butler-app/client/shared/task-graph-contracts.ts:14 TaskDocumentRef
#[derive(Debug, Clone, PartialEq, Deserialize)]
pub(crate) struct TaskDocumentRef {
    pub(crate) id: String,
    pub(crate) revision: String,
    pub(crate) title: String,
    pub(crate) status: TaskGraphStatus,
    pub(crate) source_label: String,
}

/// TS: packages/butler-app/client/shared/dashboard-space-contracts.ts:221 ProjectDashboardDocumentType
#[derive(Debug, Clone, PartialEq, Deserialize)]
#[serde(rename_all = "snake_case")]
pub(crate) enum ProjectDashboardDocumentType {
    #[serde(rename = "plan")]
    Plan,
    #[serde(rename = "task")]
    Task,
    #[serde(rename = "spec")]
    Spec,
    #[serde(rename = "report")]
    Report,
    #[serde(rename = "artifact")]
    Artifact,
    #[serde(rename = "reference")]
    Reference,
    #[serde(rename = "message")]
    Message,
    #[serde(rename = "roadmap")]
    Roadmap,
    #[serde(rename = "work")]
    Work,
    #[serde(other)]
    Unknown,
}
