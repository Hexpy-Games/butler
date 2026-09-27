use std::path::PathBuf;

use serde::Serialize;
use serde_json::Value;

#[derive(Clone, Debug, Default)]
pub(crate) struct ProjectCapsuleMaintenanceResult {
    pub(crate) considered: usize,
    pub(crate) refreshed: usize,
    // The maintenance projection exposes only a failure count; details are journaled per project.
    pub(crate) failed: Vec<()>,
}

#[derive(Clone, Debug)]
pub(super) struct ProjectRegistryEntry {
    pub name: String,
    pub raw: Value,
}

#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct TaskSummary {
    pub id: String,
    pub project: String,
    pub status: String,
    pub request: String,
    pub result: String,
    pub source_path: String,
}

#[derive(Clone, Debug, PartialEq, Serialize)]
pub(super) struct ProjectTextEvidence {
    pub path: String,
    pub text: String,
}

#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct ProjectGraphEvidence {
    pub source_id: i64,
    pub mention_project: Option<String>,
    pub entity_project: Option<String>,
    pub provenance: String,
    pub text: String,
}

#[derive(Clone, Debug, PartialEq, Serialize)]
pub(super) struct ProjectCapsuleSourceSnapshot {
    pub registry: Option<Value>,
    pub tasks: Vec<TaskSummary>,
    pub evidence: Vec<ProjectTextEvidence>,
    pub feedback: Vec<ProjectTextEvidence>,
    pub graph: Vec<ProjectGraphEvidence>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub workspace_path: Option<String>,
}

#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub(super) struct ProjectCapsuleSourceCounts {
    pub registry: usize,
    pub tasks: usize,
    pub explicit_feedback: usize,
    pub project_hot_cache: usize,
    pub memory_evidence: usize,
    pub graph_evidence: usize,
    pub promoted: usize,
}

pub(super) struct PreparedCapsule {
    pub project_id: String,
    pub path: PathBuf,
    pub body: String,
    pub source_revision: String,
    pub snapshot: ProjectCapsuleSourceSnapshot,
}
