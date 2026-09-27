use serde::{Deserialize, Serialize};
use serde_json::Value;

use super::super::contracts::{
    Checkpoint, WorkDisposition, WorkPlan, WorkReview, WorkTurnScope, WorkView,
};
use super::identity::{ProjectWorkBinding, ResolvedProjectWorkScope};

/// A legacy ledger record (passthrough JSON content).
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LegacyProjectWorkRecord {
    pub record_id: String,
    pub status: String,
    pub content: Value,
}

/// A legacy (R2) program with its records (passthrough JSON).
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LegacyProjectWorkSourceSnapshot {
    pub source_program_id: String,
    pub source_revision: String,
    pub goal_contract: Value,
    pub plan: Value,
    pub works: Vec<LegacyProjectWorkRecord>,
    pub tasks: Vec<LegacyProjectWorkRecord>,
    pub referenced_records: Vec<LegacyProjectWorkReferencedRecord>,
}

/// A record a legacy program references.
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LegacyProjectWorkReferencedRecord {
    pub record_id: String,
    pub content: Value,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ProjectWorkLegacySourceKind {
    SqliteR3,
    RawR2,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectWorkLegacyCheckpoint {
    pub checkpoint: Checkpoint,
    pub from_result_sequence: u64,
    pub to_result_sequence: u64,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectWorkLegacyDisposition {
    pub disposition: WorkDisposition,
    pub historical_view: WorkView,
    pub effect_watermark: String,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectWorkLegacyTurn {
    pub turn_id: String,
    pub session_id: String,
    pub original_message_id: String,
    pub original_message: String,
    pub semantic_state: String,
    pub execution_fence: u64,
}

/// Legacy Work projected for import, digested over its semantic JSON.
#[derive(Clone, Debug)]
pub struct ProjectWorkLegacySnapshot {
    pub source_kind: ProjectWorkLegacySourceKind,
    pub source_program_id: String,
    pub source_program_ids: Vec<String>,
    pub source_identity: String,
    pub source_sha256: String,
    pub work: WorkView,
    pub plans: Vec<WorkPlan>,
    pub checkpoints: Vec<ProjectWorkLegacyCheckpoint>,
    pub reviews: Vec<WorkReview>,
    pub dispositions: Vec<ProjectWorkLegacyDisposition>,
    pub bindings: Vec<ProjectWorkBinding>,
    pub turns: Vec<ProjectWorkLegacyTurn>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ProjectWorkLegacyObservation {
    pub source_program_id: String,
    pub source_sha256: String,
    pub work_id: String,
}

/// The scope a legacy import runs in.
#[derive(Clone, Debug)]
pub struct ProjectWorkLegacyInput {
    pub scope: WorkTurnScope,
    pub resolved_scope: ResolvedProjectWorkScope,
}

/// An import snapshot to observe at a ledger head.
#[derive(Clone)]
pub struct ProjectWorkLegacyObserveInput {
    pub scope: WorkTurnScope,
    pub resolved_scope: ResolvedProjectWorkScope,
    pub snapshot: Arc<ProjectWorkLegacySnapshot>,
    pub canonical_head_sha256: String,
    /// Current canonical refs are compared with the snapshot before same-lane raw-result rereads.
    pub canonical_result_refs: Vec<super::super::contracts::ToolResultRef>,
}
use std::sync::Arc;
