use serde::{Deserialize, Serialize};

use super::view::{
    ActionProgress, DispositionActionUpdate, DispositionStatus, ExecutionMode, PlanAction,
    ReviewSubject, ReviewVerdict, WorkStage,
};

/// The turn (and optional project) a Work command acts in.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkTurnScope {
    pub turn_id: String,
    pub session_id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub project_ref: Option<String>,
}

/// Starts new Work.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StartWorkInput {
    #[serde(flatten)]
    pub scope: WorkTurnScope,
    pub mutation_call_id: String,
    pub objective: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub backfill_tool_call_ids: Option<Vec<String>>,
}

/// Continues existing Work.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ContinueWorkInput {
    #[serde(flatten)]
    pub scope: WorkTurnScope,
    pub mutation_call_id: String,
    pub work_id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub backfill_tool_call_ids: Option<Vec<String>>,
}

/// Replaces the Work's plan.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ReplacePlanInput {
    #[serde(flatten)]
    pub scope: WorkTurnScope,
    pub mutation_call_id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub start_new: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub backfill_tool_call_ids: Option<Vec<String>>,
    pub objective: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub governing_refs: Option<Vec<String>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub execution_mode: Option<ExecutionMode>,
    pub actions: Vec<PlanAction>,
    pub checks: Vec<String>,
}

/// Records progress.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CheckpointInput {
    #[serde(flatten)]
    pub scope: WorkTurnScope,
    pub mutation_call_id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub next_stage: Option<WorkStage>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub action_updates: Option<Vec<ActionProgress>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub public_summary: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub next_step: Option<String>,
}

/// Which stage a revise verdict sends the Work back to.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum CorrectionScope {
    Planning,
    Execution,
}

/// Records a review.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ReviewInput {
    #[serde(flatten)]
    pub scope: WorkTurnScope,
    pub mutation_call_id: String,
    pub subject: ReviewSubject,
    pub verdict: ReviewVerdict,
    pub summary: String,
    pub corrections: Vec<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub action_updates: Option<Vec<ActionProgress>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub correction_scope: Option<CorrectionScope>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub next_stage: Option<WorkStage>,
}

/// Records a disposition.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DispositionInput {
    #[serde(flatten)]
    pub scope: WorkTurnScope,
    pub mutation_call_id: String,
    pub work_id: String,
    pub disposition: DispositionStatus,
    pub summary: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub action_updates: Option<Vec<DispositionActionUpdate>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub remaining_actions: Option<Vec<String>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub next_condition: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub evidence_refs: Option<Vec<String>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub followups: Option<Vec<String>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub backfill_tool_call_ids: Option<Vec<String>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub expected_material_fingerprint: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub runtime_owned_open_generation: Option<RuntimeOwnedOpenGeneration>,
}

/// Marks an open disposition owned by the runtime (may reopen completed Work).
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct RuntimeOwnedOpenGeneration {
    pub version: u8,
}

/// Claims a closeout correction for a Work.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ClaimCloseoutCorrectionInput {
    #[serde(flatten)]
    pub scope: WorkTurnScope,
    pub work_id: String,
}

/// A validated start with its request fingerprint.
#[derive(Clone, Debug)]
pub struct StartWorkCommand {
    pub input: StartWorkInput,
    pub request_sha256: String,
}
/// A validated continuation with its request fingerprint.
#[derive(Clone, Debug)]
pub struct ContinueWorkCommand {
    pub input: ContinueWorkInput,
    pub request_sha256: String,
}
/// A validated plan replacement with the progress it resets.
#[derive(Clone, Debug)]
pub struct ReplacePlanCommand {
    pub input: ReplacePlanInput,
    pub request_sha256: String,
    pub start_new: bool,
    pub governing_refs: Vec<String>,
    pub expected_work_id: Option<String>,
    pub expected_progress_revision: Option<u64>,
    pub action_progress: Vec<ActionProgress>,
    pub opening_plan: bool,
}
/// A validated checkpoint with the revisions it expects.
#[derive(Clone, Debug)]
pub struct CheckpointCommand {
    pub input: CheckpointInput,
    pub expected_plan_revision_id: String,
    pub expected_progress_revision: u64,
    pub request_sha256: String,
    pub stage: WorkStage,
    pub action_progress: Vec<ActionProgress>,
    pub public_summary: String,
    pub next_step: String,
}
/// A validated review with the revisions it expects and its stage transition.
#[derive(Clone, Debug)]
pub struct ReviewCommand {
    pub input: ReviewInput,
    pub expected_plan_revision_id: String,
    pub expected_progress_revision: u64,
    pub expected_result_sequence: u64,
    pub expected_result_review_revision_id: Option<String>,
    pub request_sha256: String,
    pub current_stage: WorkStage,
    pub entry_stage: WorkStage,
    pub next_stage: WorkStage,
    pub action_progress: Vec<ActionProgress>,
    pub progress_changed: bool,
}
/// A validated disposition with its normalized content and expected material.
#[derive(Clone, Debug)]
pub struct DispositionCommand {
    pub input: DispositionInput,
    pub request_sha256: String,
    pub normalized_summary: String,
    pub action_updates: Vec<DispositionActionUpdate>,
    pub remaining_actions: Vec<String>,
    pub evidence_refs: Vec<String>,
    pub followups: Vec<String>,
}
