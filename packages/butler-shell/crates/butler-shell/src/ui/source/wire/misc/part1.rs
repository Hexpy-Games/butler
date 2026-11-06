//! Typed renderer wire contracts; field names follow their TypeScript sources.
use crate::ui::source::wire::{
    SharedSessionArtifactSummary, TaskGraphCounts, TaskGraphNode, TaskGraphPhase, TaskGraphState,
};
use serde::Deserialize;

/// TS: packages/butler-app/client/ui/src/app/types.ts:1598 NewChatBriefingView (inline NewChatBriefingViewSourceScope).
#[derive(Debug, Clone, PartialEq, Deserialize)]
#[serde(rename_all = "snake_case")]
pub(crate) enum NewChatBriefingViewSourceScope {
    #[serde(rename = "project")]
    Project,
    #[serde(rename = "general")]
    General,
    #[serde(rename = "onboarding")]
    Onboarding,
    #[serde(other)]
    Unknown,
}

/// TS: packages/butler-app/client/ui/src/app/types.ts:1599 NewChatBriefingView (inline NewChatBriefingViewSourceContentOrigin).
#[derive(Debug, Clone, PartialEq, Deserialize)]
#[serde(rename_all = "snake_case")]
pub(crate) enum NewChatBriefingViewSourceContentOrigin {
    #[serde(rename = "generated")]
    Generated,
    #[serde(rename = "heuristic_fallback")]
    HeuristicFallback,
    #[serde(other)]
    Unknown,
}

/// TS: packages/butler-app/client/ui/src/app/types.ts:1602 NewChatBriefingView (inline NewChatBriefingViewSourceLocale).
#[derive(Debug, Clone, PartialEq, Deserialize)]
#[serde(rename_all = "snake_case")]
pub(crate) enum NewChatBriefingViewSourceLocale {
    #[serde(rename = "ko")]
    Ko,
    #[serde(rename = "en")]
    En,
    #[serde(other)]
    Unknown,
}

/// TS: packages/butler-app/client/ui/src/app/types.ts:1597 NewChatBriefingView (inline NewChatBriefingViewSource).
#[derive(Debug, Clone, PartialEq, Deserialize)]
pub(crate) struct NewChatBriefingViewSource {
    pub(crate) scope: NewChatBriefingViewSourceScope,
    pub(crate) content_origin: NewChatBriefingViewSourceContentOrigin,
    #[serde(default)]
    pub(crate) consolidation_run_id: Option<String>,
    pub(crate) generated_at: String,
    pub(crate) locale: NewChatBriefingViewSourceLocale,
    #[serde(default)]
    pub(crate) project_id: Option<String>,
    #[serde(default)]
    pub(crate) project_name: Option<String>,
    pub(crate) persona_applied: bool,
    pub(crate) profile_projection_applied: bool,
}

/// TS: packages/butler-app/client/ui/src/app/types.ts:1592 NewChatBriefingView
#[derive(Debug, Clone, PartialEq, Deserialize)]
pub(crate) struct NewChatBriefingView {
    pub(crate) moment: String,
    pub(crate) title: String,
    #[serde(default)]
    pub(crate) description: Option<String>,
    #[serde(default)]
    pub(crate) suggestions: Vec<NewChatBriefingSuggestion>,
    pub(crate) source: NewChatBriefingViewSource,
    pub(crate) raw_text_included: bool,
}

/// TS: packages/butler-app/client/ui/src/app/types.ts:1881 CommandPaletteResult (inline CommandPaletteResultKind).
#[derive(Debug, Clone, PartialEq, Deserialize)]
#[serde(rename_all = "snake_case")]
pub(crate) enum CommandPaletteResultKind {
    #[serde(rename = "chat")]
    Chat,
    #[serde(rename = "project")]
    Project,
    #[serde(rename = "group")]
    Group,
    #[serde(rename = "project_session")]
    ProjectSession,
    #[serde(rename = "automation")]
    Automation,
    #[serde(rename = "settings")]
    Settings,
    #[serde(other)]
    Unknown,
}

/// TS: packages/butler-app/client/ui/src/app/types.ts:1876 CommandPaletteResult
#[derive(Debug, Clone, PartialEq, Deserialize)]
pub(crate) struct CommandPaletteResult {
    #[serde(default)]
    pub(crate) schedule: Option<CalendarSchedule>,
    #[serde(default)]
    pub(crate) schedule_type: Option<String>,
    #[serde(default)]
    pub(crate) interval_seconds: Option<i64>,
    pub(crate) id: String,
    pub(crate) kind: CommandPaletteResultKind,
    pub(crate) title: String,
    #[serde(default)]
    pub(crate) subtitle: Option<String>,
    pub(crate) route: String,
}

/// TS: packages/butler-app/client/ui/src/app/types.ts:1854 WorkStatusView (inline WorkStatusViewCounts).
#[derive(Debug, Clone, PartialEq, Deserialize)]
pub(crate) struct WorkStatusViewCounts {
    pub(crate) running: i64,
    pub(crate) completed: i64,
    pub(crate) attention: i64,
    pub(crate) operational_action: i64,
    pub(crate) operational_interruption: i64,
}

/// TS: packages/butler-app/client/ui/src/app/types.ts:1852 WorkStatusView
#[derive(Debug, Clone, PartialEq, Deserialize)]
pub(crate) struct WorkStatusView {
    #[serde(default)]
    pub(crate) items: Vec<WorkStatusItemView>,
    pub(crate) counts: WorkStatusViewCounts,
}

/// TS: packages/butler-app/client/shared/task-graph-contracts.ts:67 TaskGraphsPage
#[derive(Debug, Clone, PartialEq, Deserialize)]
pub(crate) struct TaskGraphsPage {
    #[serde(default)]
    pub(crate) graphs: Vec<TaskGraphSummary>,
    #[serde(default)]
    pub(crate) cursor: Option<String>,
    pub(crate) graph_revision: String,
    pub(crate) total: i64,
    pub(crate) event_seq: i64,
}

/// TS: packages/butler-app/client/shared/task-graph-contracts.ts:77 TaskGraphSnapshot (inline TaskGraphSnapshotEdgesItem).
#[derive(Debug, Clone, PartialEq, Deserialize)]
pub(crate) struct TaskGraphSnapshotEdgesItem {
    pub(crate) from: String,
    pub(crate) to: String,
}

/// TS: packages/butler-app/client/shared/task-graph-contracts.ts:78 TaskGraphSnapshot (inline TaskGraphSnapshotTotals).
#[derive(Debug, Clone, PartialEq, Deserialize)]
pub(crate) struct TaskGraphSnapshotTotals {
    pub(crate) nodes: i64,
    pub(crate) edges: i64,
}

/// TS: packages/butler-app/client/shared/task-graph-contracts.ts:60 TaskGraphSummary (inline TaskGraphSnapshotWorkState).
#[derive(Debug, Clone, PartialEq, Deserialize)]
#[serde(rename_all = "snake_case")]
pub(crate) enum TaskGraphSnapshotWorkState {
    #[serde(rename = "open")]
    Open,
    #[serde(rename = "completed")]
    Completed,
    #[serde(rename = "blocked")]
    Blocked,
    #[serde(rename = "abandoned")]
    Abandoned,
    #[serde(other)]
    Unknown,
}

/// TS: packages/butler-app/client/shared/task-graph-contracts.ts:74 TaskGraphSnapshot
#[derive(Debug, Clone, PartialEq, Deserialize)]
pub(crate) struct TaskGraphSnapshot {
    #[serde(default)]
    pub(crate) nodes: Vec<TaskGraphNode>,
    #[serde(default)]
    pub(crate) edges: Vec<TaskGraphSnapshotEdgesItem>,
    pub(crate) totals: TaskGraphSnapshotTotals,
    #[serde(default)]
    pub(crate) cursor: Option<String>,
    pub(crate) event_seq: i64,
    pub(crate) graph_id: String,
    pub(crate) phase: TaskGraphPhase,
    pub(crate) work_state: TaskGraphSnapshotWorkState,
    pub(crate) title: String,
    pub(crate) state: TaskGraphState,
    pub(crate) counts: TaskGraphCounts,
    pub(crate) graph_revision: String,
    pub(crate) updated_at: String,
}

/// TS: packages/butler-app/client/shared/task-graph-contracts.ts:119 TaskGraphDocument
#[derive(Debug, Clone, PartialEq, Deserialize)]
pub(crate) struct TaskGraphDocument {
    pub(crate) kind: String,
    pub(crate) document_type: String,
    pub(crate) source_label: String,
    #[serde(default)]
    pub(crate) spec_ref: Option<String>,
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
    pub(crate) title: String,
    #[serde(default)]
    pub(crate) category: Option<String>,
    #[serde(default)]
    pub(crate) status: Option<String>,
    pub(crate) safe_path_label: String,
    pub(crate) markdown: String,
    pub(crate) updated_at: String,
}

/// TS: packages/butler-app/client/ui/src/app/types.ts:1583 NewChatBriefingSuggestion
#[derive(Debug, Clone, PartialEq, Deserialize)]
pub(crate) struct NewChatBriefingSuggestion {
    pub(crate) id: String,
    pub(crate) title: String,
    pub(crate) description: String,
    pub(crate) text: String,
    #[serde(default)]
    pub(crate) template: Option<bool>,
}

/// TS: packages/butler-app/client/ui/src/app/types.ts:2036 CalendarSchedule (inline CalendarScheduleKind).
#[derive(Debug, Clone, PartialEq, Deserialize)]
#[serde(rename_all = "snake_case")]
pub(crate) enum CalendarScheduleKind {
    #[serde(rename = "daily")]
    Daily,
    #[serde(rename = "weekly")]
    Weekly,
    #[serde(other)]
    Unknown,
}

/// TS: packages/butler-app/client/ui/src/app/types.ts:2035 CalendarSchedule
#[derive(Debug, Clone, PartialEq, Deserialize)]
pub(crate) struct CalendarSchedule {
    pub(crate) kind: CalendarScheduleKind,
    pub(crate) time: String,
    #[serde(default)]
    pub(crate) weekdays: Vec<i64>,
    pub(crate) tz: String,
}

/// TS: packages/butler-app/client/ui/src/app/types.ts:1843 WorkStatusItemView (inline WorkStatusItemViewStage).
#[derive(Debug, Clone, PartialEq, Deserialize)]
#[serde(rename_all = "snake_case")]
pub(crate) enum WorkStatusItemViewStage {
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

/// TS: packages/butler-app/client/ui/src/app/types.ts:1838 WorkStatusItemView
#[derive(Debug, Clone, PartialEq, Deserialize)]
pub(crate) struct WorkStatusItemView {
    pub(crate) session_id: String,
    pub(crate) safe_title: String,
    pub(crate) safe_summary: String,
    pub(crate) state: WorkStatusState,
    #[serde(default)]
    pub(crate) stage: Option<WorkStatusItemViewStage>,
    pub(crate) completed_actions: i64,
    pub(crate) total_actions: i64,
    pub(crate) effect_count: i64,
    #[serde(default)]
    pub(crate) latest_report_summary: Option<String>,
    #[serde(default)]
    pub(crate) recent_artifacts: Option<Vec<String>>,
    pub(crate) updated_at: String,
}

/// TS: packages/butler-app/client/ui/src/app/types.ts:1831 WorkStatusState
#[derive(Debug, Clone, PartialEq, Deserialize)]
#[serde(rename_all = "snake_case")]
pub(crate) enum WorkStatusState {
    #[serde(rename = "running")]
    Running,
    #[serde(rename = "completed")]
    Completed,
    #[serde(rename = "attention")]
    Attention,
    #[serde(rename = "operational_action")]
    OperationalAction,
    #[serde(rename = "operational_interruption")]
    OperationalInterruption,
    #[serde(other)]
    Unknown,
}

/// TS: packages/butler-app/client/shared/task-graph-contracts.ts:57 TaskGraphSummary
#[derive(Debug, Clone, PartialEq, Deserialize)]
pub(crate) struct TaskGraphSummary {
    pub(crate) graph_id: String,
    pub(crate) phase: TaskGraphPhase,
    pub(crate) work_state: TaskGraphSnapshotWorkState,
    pub(crate) title: String,
    pub(crate) state: TaskGraphState,
    pub(crate) counts: TaskGraphCounts,
    pub(crate) graph_revision: String,
    pub(crate) updated_at: String,
}

/// TS: packages/butler-app/client/shared/task-graph-contracts.ts:51 TaskGraphNode (inline TaskGraphNodeReasonCode).
#[derive(Debug, Clone, PartialEq, Deserialize)]
#[serde(rename_all = "snake_case")]
pub(crate) enum TaskGraphNodeReasonCode {
    #[serde(rename = "action_blocked")]
    ActionBlocked,
    #[serde(rename = "attempt_failed")]
    AttemptFailed,
    #[serde(rename = "result_received")]
    ResultReceived,
    #[serde(rename = "review_revised")]
    ReviewRevised,
    #[serde(rename = "work_abandoned")]
    WorkAbandoned,
    #[serde(other)]
    Unknown,
}
