//! Typed renderer wire contracts; field names follow their TypeScript sources.
use crate::ui::source::wire::{
    InitiatedOriginPanelCanonHoldState, InitiatedOriginPanelCanonTakeHereState,
    InitiatedOriginPanelSchedulePauseState, SubtaskWorkerViewStatus,
};
use serde::Deserialize;

/// TS: packages/butler-app/client/ui/src/app/types.ts:1198 SubtaskWorkerView
#[derive(Debug, Clone, PartialEq, Deserialize)]
pub(crate) struct SubtaskWorkerView {
    pub(crate) session_id: String,
    pub(crate) relation_id: String,
    pub(crate) title: String,
    pub(crate) status: SubtaskWorkerViewStatus,
}

/// TS: packages/butler-app/client/ui/src/app/types.ts:890 ChangedFileLine (inline ChangedFileLineType).
#[derive(Debug, Clone, PartialEq, Deserialize)]
#[serde(rename_all = "snake_case")]
pub(crate) enum ChangedFileLineType {
    #[serde(rename = "deleted")]
    Deleted,
    #[serde(rename = "added")]
    Added,
    #[serde(other)]
    Unknown,
}

/// TS: packages/butler-app/client/ui/src/app/types.ts:889 ChangedFileLine
#[derive(Debug, Clone, PartialEq, Deserialize)]
pub(crate) struct ChangedFileLine {
    pub(crate) r#type: ChangedFileLineType,
    #[serde(default)]
    pub(crate) old_line: Option<i64>,
    #[serde(default)]
    pub(crate) new_line: Option<i64>,
    pub(crate) content: String,
}

/// TS: packages/butler-app/client/ui/src/app/initiatedTypes.ts:36 PatternProposalPanel
#[derive(Debug, Clone, PartialEq, Deserialize)]
pub(crate) struct PatternProposalPanel {
    pub(crate) kind: String,
    pub(crate) bundle_id: String,
    #[serde(default)]
    pub(crate) candidates: Vec<PatternCandidate>,
}

/// TS: packages/butler-app/client/ui/src/app/initiatedTypes.ts:41 SchedulePausePanel
#[derive(Debug, Clone, PartialEq, Deserialize)]
pub(crate) struct SchedulePausePanel {
    pub(crate) kind: String,
    pub(crate) automation_id: String,
    pub(crate) state: InitiatedOriginPanelSchedulePauseState,
    pub(crate) title: String,
    pub(crate) schedule: InitiatedSchedule,
    pub(crate) unopened_count: i64,
}

/// TS: packages/butler-app/client/shared/canon-queue-contracts.ts:32 CanonHoldPanel
#[derive(Debug, Clone, PartialEq, Deserialize)]
pub(crate) struct CanonHoldPanel {
    pub(crate) kind: String,
    pub(crate) session_id: String,
    pub(crate) epic_id: String,
    pub(crate) epic_title: String,
    pub(crate) state: InitiatedOriginPanelCanonHoldState,
}

/// TS: packages/butler-app/client/shared/canon-queue-contracts.ts:40 CanonTakeHerePanel
#[derive(Debug, Clone, PartialEq, Deserialize)]
pub(crate) struct CanonTakeHerePanel {
    pub(crate) kind: String,
    pub(crate) session_id: String,
    pub(crate) epic_id: String,
    pub(crate) epic_title: String,
    pub(crate) other_session_id: String,
    pub(crate) state: InitiatedOriginPanelCanonTakeHereState,
}

/// TS: packages/butler-app/client/ui/src/app/initiatedTypes.ts:30 PatternCandidate (inline PatternCandidateState).
#[derive(Debug, Clone, PartialEq, Deserialize)]
#[serde(rename_all = "snake_case")]
pub(crate) enum PatternCandidateState {
    #[serde(rename = "accepted")]
    Accepted,
    #[serde(rename = "pending")]
    Pending,
    #[serde(rename = "declined")]
    Declined,
    #[serde(other)]
    Unknown,
}

/// TS: packages/butler-app/client/ui/src/app/initiatedTypes.ts:32 PatternCandidate (inline PatternCandidateAction).
#[derive(Debug, Clone, PartialEq, Deserialize)]
pub(crate) struct PatternCandidateAction {
    pub(crate) title: String,
    pub(crate) schedule: InitiatedSchedule,
    pub(crate) deliver_to: String,
}

/// TS: packages/butler-app/client/ui/src/app/initiatedTypes.ts:33 PatternCandidate (inline PatternCandidateEvidence).
#[derive(Debug, Clone, PartialEq, Deserialize)]
pub(crate) struct PatternCandidateEvidence {
    pub(crate) count: i64,
    pub(crate) first_at: String,
    pub(crate) last_at: String,
}

/// TS: packages/butler-app/client/ui/src/app/initiatedTypes.ts:28 PatternCandidate
#[derive(Debug, Clone, PartialEq, Deserialize)]
pub(crate) struct PatternCandidate {
    pub(crate) pattern_id: String,
    pub(crate) state: PatternCandidateState,
    pub(crate) title: String,
    pub(crate) action: PatternCandidateAction,
    pub(crate) evidence: PatternCandidateEvidence,
    #[serde(default)]
    pub(crate) automation_id: Option<String>,
}

/// TS: packages/butler-app/client/ui/src/app/initiatedTypes.ts:24 InitiatedSchedule (inline InitiatedScheduleType).
#[derive(Debug, Clone, PartialEq, Deserialize)]
#[serde(rename_all = "snake_case")]
pub(crate) enum InitiatedScheduleType {
    #[serde(rename = "daily")]
    Daily,
    #[serde(rename = "weekly")]
    Weekly,
    #[serde(rename = "weekdays")]
    Weekdays,
    #[serde(rename = "interval")]
    Interval,
    #[serde(rename = "once")]
    Once,
    #[serde(other)]
    Unknown,
}

/// TS: packages/butler-app/client/ui/src/app/initiatedTypes.ts:23 InitiatedSchedule
#[derive(Debug, Clone, PartialEq, Deserialize)]
pub(crate) struct InitiatedSchedule {
    pub(crate) r#type: InitiatedScheduleType,
    #[serde(default)]
    pub(crate) time: Option<String>,
    #[serde(default)]
    pub(crate) weekdays: Option<Vec<i64>>,
}
