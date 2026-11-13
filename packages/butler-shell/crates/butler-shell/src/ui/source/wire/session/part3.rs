//! Typed renderer wire contracts; field names follow their TypeScript sources.
use crate::ui::source::wire::{
    AccessMode, CalendarSchedule, InterfaceTextReference, MessageFileRef, ProgressRow,
    ReasoningEffort, RuntimeDeliveryState, SessionViewStatus, SessionViewTurn, StewardResultView,
    SubtaskState, SubtaskWorkerView, WorkBlockView, WorkPlan, WorkerActivityPhase,
};
use serde::Deserialize;

/// TS: packages/butler-app/client/ui/src/app/types.ts:1141 SessionViewMessageWindow
#[derive(Debug, Clone, PartialEq, Deserialize)]
pub(crate) struct SessionViewMessageWindow {
    pub(crate) next_cursor: i64,
    pub(crate) complete: bool,
    #[serde(default)]
    pub(crate) previous_cursor: Option<i64>,
    #[serde(default)]
    pub(crate) previous_cursor_token: Option<String>,
    #[serde(default)]
    pub(crate) requested_cursor: Option<i64>,
    #[serde(default)]
    pub(crate) requested_cursor_token: Option<String>,
    #[serde(default)]
    pub(crate) requested_before_cursor: Option<i64>,
    #[serde(default)]
    pub(crate) requested_before_cursor_token: Option<String>,
    #[serde(default)]
    pub(crate) next_cursor_token: Option<String>,
    #[serde(default)]
    pub(crate) has_more: Option<bool>,
}

/// TS: packages/butler-app/client/ui/src/app/types.ts:1712 WorkerActivitySummary (inline WorkerActivitySummaryActivityKind).
#[derive(Debug, Clone, PartialEq, Deserialize)]
#[serde(rename_all = "snake_case")]
pub(crate) enum WorkerActivitySummaryActivityKind {
    #[serde(rename = "planned")]
    Planned,
    #[serde(rename = "worker")]
    Worker,
    #[serde(other)]
    Unknown,
}

/// TS: packages/butler-app/client/ui/src/app/types.ts:1709 WorkerActivitySummary
#[derive(Debug, Clone, PartialEq, Deserialize)]
pub(crate) struct WorkerActivitySummary {
    #[serde(default)]
    pub(crate) action_key: Option<String>,
    pub(crate) worker_id: String,
    #[serde(default)]
    pub(crate) activity_kind: Option<WorkerActivitySummaryActivityKind>,
    pub(crate) worker_label: String,
    #[serde(default)]
    pub(crate) worker_display_name: Option<String>,
    #[serde(default)]
    pub(crate) worker_ordinal_label: Option<String>,
    pub(crate) objective: String,
    pub(crate) phase: WorkerActivityPhase,
    #[serde(default)]
    pub(crate) semantic_phase: Option<WorkerActivityPhase>,
    #[serde(default)]
    pub(crate) action_kind: Option<String>,
    pub(crate) status_line: String,
    #[serde(default)]
    pub(crate) status_reference: Option<InterfaceTextReference>,
    #[serde(default)]
    pub(crate) current_activity_reference: Option<InterfaceTextReference>,
    #[serde(default)]
    pub(crate) current_activity_title: Option<String>,
    #[serde(default)]
    pub(crate) work_blocks: Option<Vec<WorkBlockView>>,
    #[serde(default)]
    pub(crate) session_id: Option<String>,
    #[serde(default)]
    pub(crate) parent_turn_id: Option<String>,
    #[serde(default)]
    pub(crate) source_tool_call_id: Option<String>,
    #[serde(default)]
    pub(crate) approved_plan_total: Option<i64>,
    #[serde(default)]
    pub(crate) approved_plan_completed: Option<i64>,
    #[serde(default)]
    pub(crate) project_id: Option<String>,
    #[serde(default)]
    pub(crate) task_id: Option<String>,
    #[serde(default)]
    pub(crate) orchestration_id: Option<String>,
    pub(crate) terminal: bool,
    #[serde(default)]
    pub(crate) created_at: Option<String>,
    #[serde(default)]
    pub(crate) updated_at: Option<String>,
    #[serde(default)]
    pub(crate) supported_controls: Vec<String>,
}

/// TS: packages/butler-app/client/ui/src/app/types.ts:1739 WorkStreamSummary
#[derive(Debug, Clone, PartialEq, Deserialize)]
pub(crate) struct WorkStreamSummary {
    pub(crate) id: String,
    pub(crate) title: String,
    #[serde(default)]
    pub(crate) owner_session_id: Option<String>,
    #[serde(default)]
    pub(crate) project_id: Option<String>,
    pub(crate) state: String,
    #[serde(default)]
    pub(crate) current_phase: Option<String>,
    #[serde(default)]
    pub(crate) active_step_id: Option<String>,
    #[serde(default)]
    pub(crate) todo_list_id: Option<String>,
    pub(crate) terminal: bool,
    pub(crate) updated_at: String,
}

/// TS: packages/butler-app/client/ui/src/app/types.ts:1684 AutomationTargetSummary
#[derive(Debug, Clone, PartialEq, Deserialize)]
pub(crate) struct AutomationTargetSummary {
    pub(crate) automation_id: String,
    pub(crate) title: String,
    #[serde(default)]
    pub(crate) interval_seconds: Option<i64>,
    #[serde(default)]
    pub(crate) schedule_type: Option<String>,
    #[serde(default)]
    pub(crate) schedule: Option<CalendarSchedule>,
    #[serde(default)]
    pub(crate) next_run_at: Option<String>,
}

/// TS: packages/butler-app/client/ui/src/app/types.ts:1154 SafeSessionError
#[derive(Debug, Clone, PartialEq, Deserialize)]
pub(crate) struct SafeSessionError {
    pub(crate) code: String,
    pub(crate) message: String,
    pub(crate) created_at: String,
}

/// TS: packages/butler-app/client/ui/src/app/types.ts:1160 SessionViewCursors
#[derive(Debug, Clone, PartialEq, Deserialize)]
pub(crate) struct SessionViewCursors {
    pub(crate) messages: i64,
    pub(crate) events: i64,
}

/// TS: packages/butler-app/client/ui/src/app/types.ts:1165 SessionRelationView
#[derive(Debug, Clone, PartialEq, Deserialize)]
pub(crate) struct SessionRelationView {
    pub(crate) relation_id: String,
    pub(crate) parent_session_id: String,
    pub(crate) parent_turn_id: String,
    pub(crate) child_session_id: String,
    pub(crate) anchor_message_id: String,
    pub(crate) ordinal: i64,
    pub(crate) safe_title: String,
    pub(crate) created_at: String,
}

/// Child summary for both `steward_children` and `workers`, from butler-turn `project_child`.
#[derive(Debug, Clone, PartialEq, Deserialize)]
pub(crate) struct StewardSessionSummaryView {
    #[serde(default)]
    pub(crate) action_key: Option<String>,
    #[serde(default)]
    pub(crate) parent_turn_id: Option<String>,
    #[serde(default)]
    pub(crate) source_tool_call_id: Option<String>,
    #[serde(default)]
    pub(crate) plan: Option<WorkPlan>,
    pub(crate) relation: SessionRelationView,
    pub(crate) session_id: String,
    pub(crate) title: String,
    pub(crate) status: SessionViewStatus,
    #[serde(default)]
    pub(crate) active_turn: Option<SessionViewTurn>,
    #[serde(default)]
    pub(crate) latest_turn: Option<SessionViewTurn>,
    #[serde(default)]
    pub(crate) waiting_for_children: Option<bool>,
    #[serde(default)]
    pub(crate) approved_plan_revision: Option<i64>,
    #[serde(default)]
    pub(crate) approved_plan_total: Option<i64>,
    #[serde(default)]
    pub(crate) approved_plan_completed: Option<i64>,
    #[serde(default)]
    pub(crate) result: Option<StewardResultView>,
    pub(crate) updated_at: String,
    pub(crate) terminal: bool,
}

/// TS: packages/butler-app/client/ui/src/app/types.ts:1206 SubtaskView
#[derive(Debug, Clone, PartialEq, Deserialize)]
pub(crate) struct SubtaskView {
    pub(crate) session_id: String,
    pub(crate) relation_id: String,
    pub(crate) title: String,
    pub(crate) state: SubtaskState,
    #[serde(default)]
    pub(crate) plan_completed: Option<i64>,
    #[serde(default)]
    pub(crate) plan_total: Option<i64>,
    pub(crate) started_at: String,
    #[serde(default)]
    pub(crate) workers: Option<Vec<SubtaskWorkerView>>,
}

/// TS: packages/butler-app/client/shared/canon-proposal-contracts.ts:3 CanonProposalAnchor
#[derive(Debug, Clone, PartialEq, Deserialize)]
pub(crate) struct CanonProposalAnchor {
    pub(crate) proposal_id: String,
    pub(crate) turn_id: String,
    pub(crate) source_call_id: String,
}

/// TS: packages/butler-app/client/ui/src/app/types.ts:1091 TurnProgressSnapshot
#[derive(Debug, Clone, PartialEq, Deserialize)]
pub(crate) struct TurnProgressSnapshot {
    #[serde(default)]
    pub(crate) summary_reference: Option<InterfaceTextReference>,
    #[serde(default)]
    pub(crate) turn_id: Option<String>,
    #[serde(default)]
    pub(crate) started_at: Option<String>,
    #[serde(default)]
    pub(crate) summary: Option<String>,
    #[serde(default)]
    pub(crate) updated_at: Option<String>,
    #[serde(default)]
    pub(crate) state: Option<String>,
    #[serde(default)]
    pub(crate) delivery_state: Option<RuntimeDeliveryState>,
    #[serde(default)]
    pub(crate) limitation_codes: Option<Vec<String>>,
    #[serde(default)]
    pub(crate) limitations: Option<Vec<String>>,
    #[serde(default)]
    pub(crate) safe_progress_rows: Vec<ProgressRow>,
}

/// TS: packages/butler-app/client/ui/src/app/types.ts:746 SessionControlState
#[derive(Debug, Clone, PartialEq, Deserialize)]
pub(crate) struct SessionControlState {
    pub(crate) model: String,
    pub(crate) reasoning_effort: ReasoningEffort,
    pub(crate) access_mode: AccessMode,
    pub(crate) plan_mode: bool,
}

/// TS: packages/butler-app/client/ui/src/app/types.ts:985 ContextUsageCategory
#[derive(Debug, Clone, PartialEq, Deserialize)]
pub(crate) struct ContextUsageCategory {
    pub(crate) id: String,
    pub(crate) label: String,
    pub(crate) used_tokens: i64,
    pub(crate) budget_tokens: i64,
    pub(crate) ratio: f64,
    pub(crate) safe_description: String,
    #[serde(default)]
    pub(crate) source_kind: Option<String>,
}

/// TS: packages/butler-app/client/ui/src/app/types.ts:29 MessageFileKind
#[derive(Debug, Clone, PartialEq, Deserialize)]
#[serde(rename_all = "snake_case")]
pub(crate) enum MessageFileKind {
    #[serde(rename = "text")]
    Text,
    #[serde(rename = "image")]
    Image,
    #[serde(rename = "generic")]
    Generic,
    #[serde(other)]
    Unknown,
}

/// TS: packages/butler-app/client/ui/src/app/types.ts:1678 ArtifactRevision
#[derive(Debug, Clone, PartialEq, Deserialize)]
pub(crate) struct ArtifactRevision {
    pub(crate) file: MessageFileRef,
    #[serde(default)]
    pub(crate) message: Option<String>,
    pub(crate) capturedAt: String,
}

/// TS: packages/butler-app/client/ui/src/app/types.ts:1223 WorkPlanAction (inline WorkPlanActionStatus).
#[derive(Debug, Clone, PartialEq, Deserialize)]
#[serde(rename_all = "snake_case")]
pub(crate) enum WorkPlanActionStatus {
    #[serde(rename = "active")]
    Active,
    #[serde(rename = "blocked")]
    Blocked,
    #[serde(rename = "done")]
    Done,
    #[serde(rename = "pending")]
    Pending,
    #[serde(rename = "skipped")]
    Skipped,
    #[serde(other)]
    Unknown,
}

/// TS: packages/butler-app/client/ui/src/app/types.ts:1218 WorkPlanAction
#[derive(Debug, Clone, PartialEq, Deserialize)]
pub(crate) struct WorkPlanAction {
    pub(crate) action_key: String,
    pub(crate) order: i64,
    pub(crate) title: String,
    pub(crate) purpose: String,
    pub(crate) status: WorkPlanActionStatus,
    #[serde(default)]
    pub(crate) started_at: Option<String>,
    #[serde(default)]
    pub(crate) finished_at: Option<String>,
    pub(crate) added_in_revision: i64,
}

/// TS: packages/butler-app/client/ui/src/app/types.ts:1229 WorkPlanRevision
#[derive(Debug, Clone, PartialEq, Deserialize)]
pub(crate) struct WorkPlanRevision {
    pub(crate) revision: i64,
    pub(crate) at: String,
    #[serde(default)]
    pub(crate) added: Vec<String>,
    #[serde(default)]
    pub(crate) removed: Vec<String>,
    #[serde(default)]
    pub(crate) reason: Option<String>,
}

/// TS: packages/butler-app/client/ui/src/app/types.ts:2044 UserQuestion (inline UserQuestionKind).
#[derive(Debug, Clone, PartialEq, Deserialize)]
#[serde(rename_all = "snake_case")]
pub(crate) enum UserQuestionKind {
    #[serde(rename = "text")]
    Text,
    #[serde(rename = "single")]
    Single,
    #[serde(rename = "multi")]
    Multi,
    #[serde(other)]
    Unknown,
}
