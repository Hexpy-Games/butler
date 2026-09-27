use serde::{Deserialize, Serialize};

use super::view::{
    ActionProgress, DispositionActionUpdate, DispositionStatus, ExecutionMode, PlanAction,
    ReviewSubject, ReviewVerdict, WorkStage,
};

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct WorkTurnScope {
    pub turn_id: String,
    pub session_id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub project_ref: Option<String>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct StartWorkInput {
    #[serde(flatten)]
    pub scope: WorkTurnScope,
    pub mutation_call_id: String,
    pub objective: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub backfill_tool_call_ids: Option<Vec<String>>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ContinueWorkInput {
    #[serde(flatten)]
    pub scope: WorkTurnScope,
    pub mutation_call_id: String,
    pub work_id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub backfill_tool_call_ids: Option<Vec<String>>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ReplacePlanInput {
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

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct CheckpointInput {
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

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub(crate) enum CorrectionScope {
    Planning,
    Execution,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ReviewInput {
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

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct DispositionInput {
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

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub(crate) struct RuntimeOwnedOpenGeneration {
    pub version: u8,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ClaimCloseoutCorrectionInput {
    #[serde(flatten)]
    pub scope: WorkTurnScope,
    pub work_id: String,
}

#[derive(Clone, Debug)]
pub(crate) struct StartWorkCommand {
    pub input: StartWorkInput,
    pub request_sha256: String,
}
#[derive(Clone, Debug)]
pub(crate) struct ContinueWorkCommand {
    pub input: ContinueWorkInput,
    pub request_sha256: String,
}
#[derive(Clone, Debug)]
pub(crate) struct ReplacePlanCommand {
    pub input: ReplacePlanInput,
    pub request_sha256: String,
    pub start_new: bool,
    pub governing_refs: Vec<String>,
    pub expected_work_id: Option<String>,
    pub expected_progress_revision: Option<u64>,
    pub action_progress: Vec<ActionProgress>,
    pub opening_plan: bool,
}
#[derive(Clone, Debug)]
pub(crate) struct CheckpointCommand {
    pub input: CheckpointInput,
    pub expected_plan_revision_id: String,
    pub expected_progress_revision: u64,
    pub request_sha256: String,
    pub stage: WorkStage,
    pub action_progress: Vec<ActionProgress>,
    pub public_summary: String,
    pub next_step: String,
}
#[derive(Clone, Debug)]
pub(crate) struct ReviewCommand {
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
#[derive(Clone, Debug)]
pub(crate) struct DispositionCommand {
    pub input: DispositionInput,
    pub request_sha256: String,
    pub normalized_summary: String,
    pub action_updates: Vec<DispositionActionUpdate>,
    pub remaining_actions: Vec<String>,
    pub evidence_refs: Vec<String>,
    pub followups: Vec<String>,
}
