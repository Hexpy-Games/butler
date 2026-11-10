//! Typed renderer wire contracts; field names follow their TypeScript sources.
use crate::ui::source::wire::{
    AnsweredUserQuestions, ArtifactRevision, AutomationTargetSummary, CanonProposalAnchor,
    ContextUsageCategory, MessageFileKind, MessageRecord, PendingUserQuestions, ProgressRow,
    SafeSessionError, SessionBranchSeed, SessionControlState, SessionRelationView,
    SessionViewCursors, SessionViewMessageWindow, SessionViewStatus, SessionViewTurn,
    StewardSessionSummaryView, SubtaskView, TurnProgressSnapshot, UiChatKind, UserQuestion,
    WorkPlanAction, WorkPlanRevision, WorkStreamSummary, WorkerActivitySummary,
};
use serde::Deserialize;

/// TS: packages/butler-app/client/ui/src/app/types.ts:1283 SessionView (inline SessionViewActivityHistoryItem).
#[derive(Debug, Clone, PartialEq, Deserialize)]
pub(crate) struct SessionViewActivityHistoryItem {
    pub(crate) turn_id: String,
    pub(crate) created_at: String,
    #[serde(default)]
    pub(crate) rows: Vec<ProgressRow>,
}

/// TS: packages/butler-app/client/ui/src/app/types.ts:1766 SessionSummaryView (inline SessionViewBranchWorkspaceMode).
#[derive(Debug, Clone, PartialEq, Deserialize)]
#[serde(rename_all = "snake_case")]
pub(crate) enum SessionViewBranchWorkspaceMode {
    #[serde(rename = "git")]
    Git,
    #[serde(rename = "folder")]
    Folder,
    #[serde(rename = "none")]
    None,
    #[serde(other)]
    Unknown,
}

/// TS: packages/butler-app/client/ui/src/app/types.ts:1770 SessionSummaryView (inline SessionViewBranchWorkspaceBinding).
#[derive(Debug, Clone, PartialEq, Deserialize)]
#[serde(rename_all = "snake_case")]
pub(crate) enum SessionViewBranchWorkspaceBinding {
    #[serde(rename = "project")]
    Project,
    #[serde(rename = "session_worktree")]
    SessionWorktree,
    #[serde(rename = "session_folder")]
    SessionFolder,
    #[serde(other)]
    Unknown,
}

/// TS: packages/butler-app/client/ui/src/app/types.ts:1774 SessionSummaryView (inline SessionViewBranchWorkspaceStatus).
#[derive(Debug, Clone, PartialEq, Deserialize)]
#[serde(rename_all = "snake_case")]
pub(crate) enum SessionViewBranchWorkspaceStatus {
    #[serde(rename = "available")]
    Available,
    #[serde(rename = "unavailable")]
    Unavailable,
    #[serde(other)]
    Unknown,
}

/// TS: packages/butler-app/client/ui/src/app/types.ts:1289 SessionView (inline SessionViewBranch).
#[derive(Debug, Clone, PartialEq, Deserialize)]
pub(crate) struct SessionViewBranch {
    #[serde(default)]
    pub(crate) available: Option<bool>,
    #[serde(default)]
    pub(crate) workspace_mode: Option<SessionViewBranchWorkspaceMode>,
    #[serde(default)]
    pub(crate) branch_name: Option<String>,
    #[serde(default)]
    pub(crate) safe_status: Option<String>,
    #[serde(default)]
    pub(crate) safe_error_code: Option<String>,
    #[serde(default)]
    pub(crate) workspace_binding: Option<SessionViewBranchWorkspaceBinding>,
    #[serde(default)]
    pub(crate) workspace_label: Option<String>,
    #[serde(default)]
    pub(crate) workspace_path: Option<String>,
    #[serde(default)]
    pub(crate) workspace_status: Option<SessionViewBranchWorkspaceStatus>,
    #[serde(default)]
    pub(crate) dirty: Option<bool>,
}

/// TS: packages/butler-app/client/ui/src/app/types.ts:1263 SessionView
#[derive(Debug, Clone, PartialEq, Deserialize)]
pub(crate) struct SessionView {
    #[serde(default)]
    pub(crate) plan: Option<WorkPlan>,
    #[serde(default)]
    pub(crate) epic_ids: Option<Vec<String>>,
    #[serde(default)]
    pub(crate) approved_plan_revision: Option<i64>,
    #[serde(default)]
    pub(crate) approved_plan_total: Option<i64>,
    #[serde(default)]
    pub(crate) approved_plan_completed: Option<i64>,
    #[serde(default)]
    pub(crate) authority_requests: Option<Vec<serde_json::Value>>,
    #[serde(default)]
    pub(crate) pending_questions: Option<Vec<PendingUserQuestions>>,
    #[serde(default)]
    pub(crate) question_answers: Option<Vec<AnsweredUserQuestions>>,
    #[serde(default)]
    pub(crate) canon_proposals: Option<Vec<CanonProposalAnchor>>,
    #[serde(default)]
    pub(crate) branch_seed: Option<SessionBranchSeed>,
    #[serde(default)]
    pub(crate) protocol_version: Option<String>,
    pub(crate) session_id: String,
    pub(crate) kind: UiChatKind,
    #[serde(default)]
    pub(crate) project_id: Option<String>,
    pub(crate) status: SessionViewStatus,
    #[serde(default)]
    pub(crate) active_turn: Option<SessionViewTurn>,
    #[serde(default)]
    pub(crate) latest_turn: Option<SessionViewTurn>,
    #[serde(default)]
    pub(crate) waiting_for_children: Option<bool>,
    #[serde(default)]
    pub(crate) messages: Vec<std::sync::Arc<MessageRecord>>,
    #[serde(default)]
    pub(crate) activity_history: Option<Vec<SessionViewActivityHistoryItem>>,
    pub(crate) message_window: SessionViewMessageWindow,
    #[serde(default)]
    pub(crate) workers: Vec<WorkerActivitySummary>,
    #[serde(default)]
    pub(crate) work_streams: Vec<WorkStreamSummary>,
    #[serde(default)]
    pub(crate) artifacts: Vec<SessionArtifactSummary>,
    #[serde(default)]
    pub(crate) context: Option<ContextDetailsView>,
    #[serde(default)]
    pub(crate) branch: Option<SessionViewBranch>,
    #[serde(default)]
    pub(crate) skills_used: Option<Vec<String>>,
    #[serde(default)]
    pub(crate) automations: Vec<AutomationTargetSummary>,
    #[serde(default)]
    pub(crate) errors: Vec<SafeSessionError>,
    pub(crate) cursors: SessionViewCursors,
    #[serde(default)]
    pub(crate) parent_session_id: Option<String>,
    #[serde(default)]
    pub(crate) relation: Option<SessionRelationView>,
    #[serde(default)]
    pub(crate) steward_children: Option<Vec<StewardSessionSummaryView>>,
    #[serde(default)]
    pub(crate) subtasks: Option<Vec<SubtaskView>>,
    pub(crate) generated_at: String,
    pub(crate) updated_at: String,
}

/// TS: packages/butler-app/client/ui/src/app/types.ts:1332 MessageListView
#[derive(Debug, Clone, PartialEq, Deserialize)]
pub(crate) struct MessageListView {
    #[serde(default)]
    pub(crate) chat_id: Option<String>,
    #[serde(default)]
    pub(crate) messages: Vec<MessageRecord>,
    #[serde(default)]
    pub(crate) turn_progress: Option<std::collections::BTreeMap<String, TurnProgressSnapshot>>,
    #[serde(default)]
    pub(crate) next_cursor: Option<i64>,
    #[serde(default)]
    pub(crate) next_cursor_token: Option<String>,
}

/// TS: packages/butler-app/client/ui/src/app/types.ts:753 SessionControlsView
#[derive(Debug, Clone, PartialEq, Deserialize)]
pub(crate) struct SessionControlsView {
    pub(crate) session_id: String,
    pub(crate) controls: SessionControlState,
    pub(crate) revision: i64,
    pub(crate) catalog_generation: String,
}

/// TS: packages/butler-app/client/ui/src/app/types.ts:1759 SessionSummaryView (inline SessionSummaryViewLatestTurnSubsessionResult).
#[derive(Debug, Clone, PartialEq, Deserialize)]
pub(crate) struct SessionSummaryViewLatestTurnSubsessionResult {
    pub(crate) relation_id: String,
    pub(crate) result_id: String,
    pub(crate) safe_title: String,
}

/// TS: packages/butler-app/client/ui/src/app/types.ts:1752 SessionSummaryView
#[derive(Debug, Clone, PartialEq, Deserialize)]
pub(crate) struct SessionSummaryView {
    #[serde(default)]
    pub(crate) epic_ids: Option<Vec<String>>,
    #[serde(default)]
    pub(crate) branch_seed: Option<SessionBranchSeed>,
    #[serde(default)]
    pub(crate) session_id: Option<String>,
    #[serde(default)]
    pub(crate) turn_state: Option<String>,
    #[serde(default)]
    pub(crate) latest_progress: Option<TurnProgressSnapshot>,
    #[serde(default)]
    pub(crate) latest_turn_cancellable: Option<bool>,
    #[serde(default)]
    pub(crate) latest_turn_subsession_result: Option<SessionSummaryViewLatestTurnSubsessionResult>,
    #[serde(default)]
    pub(crate) branch_info: Option<SessionViewBranch>,
    #[serde(default)]
    pub(crate) context_details: Option<ContextDetailsView>,
    #[serde(default)]
    pub(crate) artifacts: Option<Vec<SessionArtifactSummary>>,
    #[serde(default)]
    pub(crate) automation_targets: Option<Vec<AutomationTargetSummary>>,
    #[serde(default)]
    pub(crate) skills_used: Option<Vec<String>>,
    #[serde(default)]
    pub(crate) worker_activity: Option<Vec<WorkerActivitySummary>>,
    #[serde(default)]
    pub(crate) work_streams: Option<Vec<WorkStreamSummary>>,
    #[serde(default)]
    pub(crate) steward_children: Option<Vec<StewardSessionSummaryView>>,
    #[serde(default)]
    pub(crate) subtasks: Option<Vec<SubtaskView>>,
}

/// TS: packages/butler-app/client/ui/src/app/types.ts:995 ContextDetailsView
#[derive(Debug, Clone, PartialEq, Deserialize)]
pub(crate) struct ContextDetailsView {
    #[serde(default)]
    pub(crate) session_id: Option<String>,
    #[serde(default)]
    pub(crate) model_ref: Option<String>,
    #[serde(default)]
    pub(crate) provider_id: Option<String>,
    #[serde(default)]
    pub(crate) model_id: Option<String>,
    #[serde(default)]
    pub(crate) token_count_source: Option<String>,
    pub(crate) used_tokens: i64,
    pub(crate) budget_tokens: i64,
    #[serde(default)]
    pub(crate) max_output_tokens: Option<i64>,
    #[serde(default)]
    pub(crate) available_working_context_tokens: Option<i64>,
    #[serde(default)]
    pub(crate) used_working_context_tokens: Option<i64>,
    #[serde(default)]
    pub(crate) usable_user_message_tokens: Option<i64>,
    #[serde(default)]
    pub(crate) auto_compact_at_tokens: Option<i64>,
    #[serde(default)]
    pub(crate) hard_pressure_at_tokens: Option<i64>,
    pub(crate) ratio: f64,
    #[serde(default)]
    pub(crate) status: Option<String>,
    #[serde(default)]
    pub(crate) categories: Vec<ContextUsageCategory>,
    #[serde(default)]
    pub(crate) updated_at: Option<String>,
}

/// TS: packages/butler-app/client/ui/src/app/types.ts:870 MessageFileRef
#[derive(Debug, Clone, PartialEq, Deserialize)]
pub(crate) struct MessageFileRef {
    #[serde(default)]
    pub(crate) source_label: Option<String>,
    #[serde(default)]
    pub(crate) deliverable: Option<bool>,
    pub(crate) file_id: String,
    pub(crate) kind: MessageFileKind,
    pub(crate) mime_type: String,
    pub(crate) safe_name: String,
    pub(crate) size_bytes: i64,
    pub(crate) sha256: String,
    pub(crate) url: String,
    #[serde(default)]
    pub(crate) signed_url: Option<String>,
    pub(crate) created_at: String,
    #[serde(default)]
    pub(crate) width: Option<i64>,
    #[serde(default)]
    pub(crate) height: Option<i64>,
}

/// TS: packages/butler-app/client/ui/src/app/types.ts:1654 SessionArtifactSummary
#[derive(Debug, Clone, PartialEq, Deserialize)]
pub(crate) struct SessionArtifactSummary {
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
    pub(crate) title: String,
    pub(crate) kind: String,
    #[serde(default)]
    pub(crate) safe_path_label: Option<String>,
    #[serde(default)]
    pub(crate) url: Option<String>,
    #[serde(default)]
    pub(crate) signed_url: Option<String>,
    #[serde(default)]
    pub(crate) size_bytes: Option<i64>,
    pub(crate) created_at: String,
    #[serde(default)]
    pub(crate) open_action: Option<String>,
    #[serde(default)]
    pub(crate) source_label: Option<String>,
    #[serde(default)]
    pub(crate) deliverable: Option<bool>,
    #[serde(default)]
    pub(crate) revisions: Option<Vec<ArtifactRevision>>,
}

/// TS: packages/butler-app/client/ui/src/app/types.ts:1237 WorkPlan
#[derive(Debug, Clone, PartialEq, Deserialize)]
pub(crate) struct WorkPlan {
    pub(crate) revision: i64,
    #[serde(default)]
    pub(crate) actions: Vec<WorkPlanAction>,
    #[serde(default)]
    pub(crate) revisions: Vec<WorkPlanRevision>,
}

/// TS: packages/butler-app/client/ui/src/app/types.ts:2050 PendingUserQuestions (inline PendingUserQuestionsQuestionState).
#[derive(Debug, Clone, PartialEq, Deserialize)]
#[serde(rename_all = "snake_case")]
pub(crate) enum PendingUserQuestionsQuestionState {
    #[serde(rename = "deferred")]
    Deferred,
    #[serde(rename = "pending")]
    Pending,
    #[serde(other)]
    Unknown,
}

/// TS: packages/butler-app/client/ui/src/app/types.ts:2051 PendingUserQuestions (inline PendingUserQuestionsQuestions).
#[derive(Debug, Clone, PartialEq, Deserialize)]
pub(crate) struct PendingUserQuestionsQuestions {
    #[serde(default)]
    pub(crate) questions: Vec<UserQuestion>,
}
