use serde::{Deserialize, Serialize};
use serde_json::Value;

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub(crate) enum WorkStage {
    Conception,
    Planning,
    Execution,
    Review,
    Validation,
    Reporting,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub(crate) enum WorkStatus {
    Open,
    Blocked,
    Completed,
    Abandoned,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub(crate) enum ActionStatus {
    Pending,
    Active,
    Done,
    Blocked,
    Skipped,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub(crate) enum ExecutionMode {
    Direct,
    Steward,
    Workers,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct PlanAction {
    pub action_key: String,
    pub description: String,
    pub dependency_keys: Vec<String>,
    // Source validation checks truthiness, while accepted-plan Effects checks
    // field presence. Keep null/falsy markers and object fields losslessly.
    #[serde(
        default,
        deserialize_with = "present_effect",
        skip_serializing_if = "Option::is_none"
    )]
    pub effect: Option<Value>,
}

fn present_effect<'de, D: serde::Deserializer<'de>>(
    deserializer: D,
) -> Result<Option<Value>, D::Error> {
    Value::deserialize(deserializer).map(Some)
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ActionProgress {
    pub action_key: String,
    pub status: ActionStatus,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub note: Option<String>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct WorkPlan {
    pub plan_revision_id: String,
    pub revision: u64,
    pub objective: String,
    pub governing_refs: Vec<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub execution_mode: Option<ExecutionMode>,
    pub actions: Vec<PlanAction>,
    pub checks: Vec<String>,
    pub origin_turn_id: String,
    pub created_at: String,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ToolResultRef {
    pub result_ref: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub revision: Option<u64>,
    pub tool_call_id: String,
    pub tool_name: String,
    pub status: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub result_sha256: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error_code: Option<String>,
    pub origin_turn_id: String,
    pub attached_at: String,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Checkpoint {
    pub checkpoint_revision_id: String,
    pub revision: u64,
    pub plan_revision_id: String,
    pub stage: WorkStage,
    pub action_progress: Vec<ActionProgress>,
    pub public_summary: String,
    pub next_step: String,
    pub referenced_result_refs: Vec<String>,
    pub origin_turn_id: String,
    pub created_at: String,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub(crate) enum ReviewSubject {
    Plan,
    Result,
    Completion,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub(crate) enum ReviewVerdict {
    Accept,
    Revise,
    Partial,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct WorkReview {
    pub review_revision_id: String,
    pub revision: u64,
    pub subject: ReviewSubject,
    pub verdict: ReviewVerdict,
    pub summary: String,
    pub corrections: Vec<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub bound_plan_revision_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub bound_result_review_revision_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub bound_action_progress: Option<Vec<ActionProgress>>,
    pub bound_result_refs: Vec<String>,
    pub origin_turn_id: String,
    pub created_at: String,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub(crate) enum DispositionStatus {
    Completed,
    Open,
    Blocked,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct DispositionActionUpdate {
    pub action_key: String,
    pub status: ActionStatus,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub note: Option<String>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct WorkDisposition {
    pub disposition_revision_id: String,
    pub revision: u64,
    pub result_sequence: u64,
    pub material_fingerprint: String,
    pub runtime_owned_open: bool,
    pub disposition: DispositionStatus,
    pub summary: String,
    pub action_updates: Vec<DispositionActionUpdate>,
    pub remaining_actions: Vec<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub next_condition: Option<String>,
    pub evidence_refs: Vec<String>,
    pub evidence_snapshot: Vec<String>,
    pub followups: Vec<String>,
    pub origin_turn_id: String,
    pub created_at: String,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct EffectBlocker {
    pub blocker_id: String,
    pub source_turn_id: String,
    pub capability: String,
    pub target: String,
    pub detail: String,
    pub created_at: String,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub(crate) enum WorkScope {
    Session {
        #[serde(rename = "sessionId")]
        session_id: String,
    },
    Project {
        #[serde(rename = "projectRef")]
        project_ref: String,
    },
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct WorkOrigin {
    pub turn_id: String,
    pub message_id: String,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct WorkView {
    pub work_id: String,
    pub session_id: String,
    pub scope: WorkScope,
    pub origin: WorkOrigin,
    pub objective: String,
    pub status: WorkStatus,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub current_stage: Option<WorkStage>,
    pub allowed_next_stages: Vec<WorkStage>,
    pub action_progress: Vec<ActionProgress>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub current_plan: Option<WorkPlan>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub latest_checkpoint: Option<Checkpoint>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub latest_plan_review: Option<WorkReview>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub latest_result_review: Option<WorkReview>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub latest_completion_validation: Option<WorkReview>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub latest_disposition: Option<WorkDisposition>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub effect_watermark: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub effect_blockers: Option<Vec<EffectBlocker>>,
    pub result_refs: Vec<ToolResultRef>,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct WorkResultFact {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub result_ref: Option<String>,
    pub tool_name: String,
    pub status: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub result_json: Option<Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error_code: Option<String>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct OriginalRequest {
    pub turn_id: String,
    pub message_id: String,
    pub content: String,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct WorkContext {
    pub work: WorkView,
    pub original_request: OriginalRequest,
    pub result_facts: Vec<WorkResultFact>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct LegacyImport {
    pub source_program_id: String,
    pub imported: bool,
    pub work: WorkView,
}
