use serde::{Deserialize, Serialize};

use super::super::contracts::{ActionProgress, WorkStatus, WorkView};

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ProjectWorkMaterialSnapshot {
    pub material_fingerprint: String,
    pub work_id: String,
    pub status: WorkStatus,
    pub current_plan: Option<ProjectWorkMaterialPlan>,
    pub action_progress: Vec<ProjectWorkMaterialProgress>,
    pub latest_checkpoint: Option<ProjectWorkMaterialCheckpoint>,
    pub reviews: Vec<Option<ProjectWorkMaterialReview>>,
    pub result_refs: Vec<ProjectWorkMaterialResultRef>,
    pub effect_watermark: Option<String>,
    pub effect_blockers: Vec<ProjectWorkMaterialBlocker>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ProjectWorkMaterialProgress {
    pub action_key: String,
    pub status: String,
    pub note: Option<String>,
}

impl From<&ActionProgress> for ProjectWorkMaterialProgress {
    fn from(value: &ActionProgress) -> Self {
        Self {
            action_key: value.action_key.clone(),
            status: serde_json::to_value(value.status)
                .ok()
                .and_then(|value| value.as_str().map(str::to_owned))
                .unwrap_or_default(),
            note: value.note.clone(),
        }
    }
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ProjectWorkMaterialPlan {
    pub plan_revision_id: String,
    pub revision: u64,
    pub objective: String,
    pub governing_refs: Vec<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub execution_mode: Option<String>,
    pub actions: Vec<ProjectWorkMaterialAction>,
    pub checks: Vec<String>,
    pub origin_turn_id: String,
    pub created_at: String,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ProjectWorkMaterialAction {
    pub action_key: String,
    pub description: String,
    pub dependency_keys: Vec<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub effect: Option<serde_json::Value>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ProjectWorkMaterialCheckpoint {
    pub revision: u64,
    pub plan_revision_id: String,
    pub stage: String,
    pub action_progress: Vec<ProjectWorkMaterialProgress>,
    pub result_sequence: usize,
    pub referenced_result_refs: Vec<String>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ProjectWorkMaterialReview {
    pub review_revision_id: String,
    pub revision: u64,
    pub verdict: String,
    pub bound_plan_revision_id: Option<String>,
    pub bound_result_review_revision_id: Option<String>,
    pub bound_action_progress: Option<Vec<ProjectWorkMaterialProgress>>,
    pub bound_result_refs: Vec<String>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ProjectWorkMaterialResultRef {
    pub result_ref: String,
    pub tool_call_id: String,
    pub status: String,
    pub origin_turn_id: String,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ProjectWorkMaterialBlocker {
    pub blocker_id: String,
    pub source_turn_id: String,
    pub capability_sha256: String,
    pub target_sha256: String,
    pub detail_sha256: String,
}

#[derive(Clone, Debug)]
pub(crate) struct ProjectWorkCapturedMaterial {
    pub material_fingerprint: String,
    pub material_snapshot: ProjectWorkMaterialSnapshot,
}

#[derive(Clone, Debug)]
pub(crate) struct ProjectWorkMaterialInput {
    pub candidate: WorkView,
}
