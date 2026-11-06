//! Typed renderer wire contracts; field names follow their TypeScript sources.
use crate::ui::source::wire::{
    ChangedFileLine, InitiatedSchedule, PatternCandidate, ProgressRow, UserQuestionKind,
};
use serde::Deserialize;

/// TS: packages/butler-app/client/ui/src/app/types.ts:2046 UserQuestion (inline UserQuestionOptionsItemKind).
#[derive(Debug, Clone, PartialEq, Deserialize)]
#[serde(rename_all = "snake_case")]
pub(crate) enum UserQuestionOptionsItemKind {
    #[serde(rename = "answer")]
    Answer,
    #[serde(rename = "skip")]
    Skip,
    #[serde(rename = "input")]
    Input,
    #[serde(other)]
    Unknown,
}

/// TS: packages/butler-app/client/ui/src/app/types.ts:2046 UserQuestion (inline UserQuestionOptionsItem).
#[derive(Debug, Clone, PartialEq, Deserialize)]
pub(crate) struct UserQuestionOptionsItem {
    pub(crate) id: String,
    pub(crate) label: String,
    #[serde(default)]
    pub(crate) description: Option<String>,
    #[serde(default)]
    pub(crate) recommended: Option<bool>,
    #[serde(default)]
    pub(crate) kind: Option<UserQuestionOptionsItemKind>,
}

/// TS: packages/butler-app/client/ui/src/app/types.ts:2042 UserQuestion
#[derive(Debug, Clone, PartialEq, Deserialize)]
pub(crate) struct UserQuestion {
    pub(crate) id: String,
    pub(crate) eyebrow: String,
    pub(crate) title: String,
    pub(crate) kind: UserQuestionKind,
    pub(crate) allow_custom: bool,
    #[serde(default)]
    pub(crate) options: Vec<UserQuestionOptionsItem>,
}

/// TS: packages/butler-app/client/ui/src/app/types.ts:30 RuntimeDeliveryState
#[derive(Debug, Clone, PartialEq, Deserialize)]
#[serde(rename_all = "snake_case")]
pub(crate) enum RuntimeDeliveryState {
    #[serde(rename = "cancelled")]
    Cancelled,
    #[serde(rename = "delivered")]
    Delivered,
    #[serde(rename = "running")]
    Running,
    #[serde(rename = "waiting_user")]
    WaitingUser,
    #[serde(rename = "system_error")]
    SystemError,
    #[serde(rename = "delivered_with_limitations")]
    DeliveredWithLimitations,
    #[serde(rename = "delivered_with_continuation")]
    DeliveredWithContinuation,
    #[serde(rename = "failed_system")]
    FailedSystem,
    #[serde(other)]
    Unknown,
}

/// TS: packages/butler-app/client/ui/src/app/types.ts:905 PlanDocumentRecord
#[derive(Debug, Clone, PartialEq, Deserialize)]
pub(crate) struct PlanDocumentRecord {
    pub(crate) id: String,
    pub(crate) title: String,
    pub(crate) status: String,
    pub(crate) markdown: String,
}

/// TS: packages/butler-app/client/ui/src/app/types.ts:896 ChangedFileDetail
#[derive(Debug, Clone, PartialEq, Deserialize)]
pub(crate) struct ChangedFileDetail {
    #[serde(default)]
    pub(crate) file_id: Option<String>,
    pub(crate) path: String,
    pub(crate) additions: i64,
    pub(crate) deletions: i64,
    #[serde(default)]
    pub(crate) lines: Vec<ChangedFileLine>,
}

/// TS: packages/butler-app/client/ui/src/app/types.ts:1340 WorkBlockView
#[derive(Debug, Clone, PartialEq, Deserialize)]
pub(crate) struct WorkBlockView {
    pub(crate) id: String,
    pub(crate) label: String,
    pub(crate) state: String,
    #[serde(default)]
    pub(crate) rows: Vec<ProgressRow>,
    #[serde(default)]
    pub(crate) decision_title: Option<String>,
    #[serde(default)]
    pub(crate) decision_summary: Option<String>,
    #[serde(default)]
    pub(crate) decision_rationale: Option<String>,
    #[serde(default)]
    pub(crate) decision_next_step: Option<String>,
    #[serde(default)]
    pub(crate) decision_source: Option<String>,
    #[serde(default)]
    pub(crate) decision_evidence_refs: Option<Vec<String>>,
    #[serde(default)]
    pub(crate) created_at: Option<String>,
}

/// TS: packages/butler-app/client/ui/src/app/initiatedTypes.ts:14 InitiatedOrigin (inline InitiatedOriginState).
#[derive(Debug, Clone, PartialEq, Deserialize)]
#[serde(rename_all = "snake_case")]
pub(crate) enum InitiatedOriginState {
    #[serde(rename = "failed")]
    Failed,
    #[serde(rename = "retrying")]
    Retrying,
    #[serde(other)]
    Unknown,
}

/// TS: packages/butler-app/client/ui/src/app/initiatedTypes.ts:44 SchedulePausePanel (inline InitiatedOriginPanelSchedulePauseState).
#[derive(Debug, Clone, PartialEq, Deserialize)]
#[serde(rename_all = "snake_case")]
pub(crate) enum InitiatedOriginPanelSchedulePauseState {
    #[serde(rename = "pending")]
    Pending,
    #[serde(rename = "continued")]
    Continued,
    #[serde(rename = "stopped")]
    Stopped,
    #[serde(other)]
    Unknown,
}

/// TS: packages/butler-app/client/shared/canon-queue-contracts.ts:38 CanonHoldPanel (inline InitiatedOriginPanelCanonHoldState).
#[derive(Debug, Clone, PartialEq, Deserialize)]
#[serde(rename_all = "snake_case")]
pub(crate) enum InitiatedOriginPanelCanonHoldState {
    #[serde(rename = "deleted")]
    Deleted,
    #[serde(rename = "pending")]
    Pending,
    #[serde(rename = "continued")]
    Continued,
    #[serde(rename = "resolved")]
    Resolved,
    #[serde(other)]
    Unknown,
}

/// TS: packages/butler-app/client/shared/canon-queue-contracts.ts:46 CanonTakeHerePanel (inline InitiatedOriginPanelCanonTakeHereState).
#[derive(Debug, Clone, PartialEq, Deserialize)]
#[serde(rename_all = "snake_case")]
pub(crate) enum InitiatedOriginPanelCanonTakeHereState {
    #[serde(rename = "deleted")]
    Deleted,
    #[serde(rename = "pending")]
    Pending,
    #[serde(rename = "taken")]
    Taken,
    #[serde(other)]
    Unknown,
}

/// TS: packages/butler-app/client/ui/src/app/initiatedTypes.ts:21 InitiatedOrigin (inline InitiatedOriginPanel).
#[derive(Debug, Clone, PartialEq, Deserialize)]
#[serde(tag = "kind")]
pub(crate) enum InitiatedOriginPanel {
    #[serde(rename = "pattern_proposal")]
    PatternProposal {
        bundle_id: String,
        #[serde(default)]
        candidates: Vec<PatternCandidate>,
    },
    #[serde(rename = "schedule_pause")]
    SchedulePause {
        automation_id: String,
        state: InitiatedOriginPanelSchedulePauseState,
        title: String,
        schedule: InitiatedSchedule,
        unopened_count: i64,
    },
    #[serde(rename = "canon_hold")]
    CanonHold {
        session_id: String,
        epic_id: String,
        epic_title: String,
        state: InitiatedOriginPanelCanonHoldState,
    },
    #[serde(rename = "canon_take_here")]
    CanonTakeHere {
        session_id: String,
        epic_id: String,
        epic_title: String,
        other_session_id: String,
        state: InitiatedOriginPanelCanonTakeHereState,
    },
}

/// TS: packages/butler-app/client/ui/src/app/initiatedTypes.ts:4 InitiatedOrigin
#[derive(Debug, Clone, PartialEq, Deserialize)]
pub(crate) struct InitiatedOrigin {
    pub(crate) kind: String,
    #[serde(default)]
    pub(crate) label: Option<String>,
    pub(crate) quiet: bool,
    #[serde(default)]
    pub(crate) automation_id: Option<String>,
    #[serde(default)]
    pub(crate) automation_title: Option<String>,
    #[serde(default)]
    pub(crate) relation_id: Option<String>,
    #[serde(default)]
    pub(crate) work_session_id: Option<String>,
    #[serde(default)]
    pub(crate) work_title: Option<String>,
    #[serde(default)]
    pub(crate) reason_code: Option<String>,
    #[serde(default)]
    pub(crate) state: Option<InitiatedOriginState>,
    #[serde(default)]
    pub(crate) run_id: Option<String>,
    #[serde(default)]
    pub(crate) approval: Option<serde_json::Value>,
    #[serde(default)]
    pub(crate) plan_title: Option<String>,
    #[serde(default)]
    pub(crate) epic_title: Option<String>,
    #[serde(default)]
    pub(crate) epic_id: Option<String>,
    #[serde(default)]
    pub(crate) panel: Option<InitiatedOriginPanel>,
}

/// TS: packages/butler-app/client/ui/src/app/types.ts:139 ProviderAuthMethod
#[derive(Debug, Clone, PartialEq, Deserialize)]
#[serde(rename_all = "snake_case")]
pub(crate) enum ProviderAuthMethod {
    #[serde(rename = "api_key")]
    ApiKey,
    #[serde(rename = "chatgpt_oauth")]
    ChatgptOauth,
    #[serde(other)]
    Unknown,
}

/// TS: packages/butler-app/client/ui/src/app/types.ts:1015 ProgressDetailRow
#[derive(Debug, Clone, PartialEq, Deserialize)]
pub(crate) struct ProgressDetailRow {
    pub(crate) id: String,
    #[serde(default)]
    pub(crate) kind: Option<String>,
    pub(crate) safe_label: String,
    #[serde(default)]
    pub(crate) safe_value: Option<String>,
    #[serde(default)]
    pub(crate) state: Option<String>,
}

/// TS: packages/butler-app/client/ui/src/app/types.ts:1693 WorkerActivityPhase
pub(crate) type WorkerActivityPhase = String;

/// TS: packages/butler-app/client/ui/src/app/types.ts:1182 StewardResultView (inline StewardResultViewStatus).
#[derive(Debug, Clone, PartialEq, Deserialize)]
#[serde(rename_all = "snake_case")]
pub(crate) enum StewardResultViewStatus {
    #[serde(rename = "cancelled")]
    Cancelled,
    #[serde(rename = "failed")]
    Failed,
    #[serde(rename = "success")]
    Success,
    #[serde(rename = "blocked")]
    Blocked,
    #[serde(other)]
    Unknown,
}

/// TS: packages/butler-app/client/ui/src/app/types.ts:1183 StewardResultView (inline StewardResultViewCode).
#[derive(Debug, Clone, PartialEq, Deserialize)]
#[serde(rename_all = "snake_case")]
pub(crate) enum StewardResultViewCode {
    #[serde(rename = "delegation_context_incomplete")]
    DelegationContextIncomplete,
    #[serde(rename = "steward_execution_failed")]
    StewardExecutionFailed,
    #[serde(rename = "steward_cancelled")]
    StewardCancelled,
    #[serde(other)]
    Unknown,
}

/// TS: packages/butler-app/client/ui/src/app/types.ts:1176 StewardResultView
#[derive(Debug, Clone, PartialEq, Deserialize)]
pub(crate) struct StewardResultView {
    pub(crate) result_id: String,
    pub(crate) relation_id: String,
    pub(crate) task_id: String,
    pub(crate) child_session_id: String,
    pub(crate) child_turn_id: String,
    pub(crate) status: StewardResultViewStatus,
    #[serde(default)]
    pub(crate) code: Option<StewardResultViewCode>,
    pub(crate) summary: String,
    #[serde(default)]
    pub(crate) acceptance_evidence: Vec<String>,
    #[serde(default)]
    pub(crate) changed_artifacts: Vec<String>,
    #[serde(default)]
    pub(crate) changed_files: Option<Vec<ChangedFileDetail>>,
    pub(crate) created_at: String,
}

/// TS: packages/butler-app/client/ui/src/app/types.ts:1195 SubtaskState
#[derive(Debug, Clone, PartialEq, Deserialize)]
#[serde(rename_all = "snake_case")]
pub(crate) enum SubtaskState {
    #[serde(rename = "working")]
    Working,
    #[serde(rename = "paused")]
    Paused,
    #[serde(rename = "needs_approval")]
    NeedsApproval,
    #[serde(other)]
    Unknown,
}

/// TS: packages/butler-app/client/ui/src/app/types.ts:1202 SubtaskWorkerView (inline SubtaskWorkerViewStatus).
#[derive(Debug, Clone, PartialEq, Deserialize)]
#[serde(rename_all = "snake_case")]
pub(crate) enum SubtaskWorkerViewStatus {
    #[serde(rename = "active")]
    Active,
    #[serde(rename = "cancelled")]
    Cancelled,
    #[serde(rename = "failed")]
    Failed,
    #[serde(rename = "completed")]
    Completed,
    #[serde(rename = "blocked")]
    Blocked,
    #[serde(rename = "waiting")]
    Waiting,
    #[serde(other)]
    Unknown,
}
