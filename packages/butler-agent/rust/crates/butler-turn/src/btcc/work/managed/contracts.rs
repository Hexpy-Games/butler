use crate::btcc::{BtccError, PortFuture};
use serde::{Deserialize, Serialize};

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct SpecRef {
    pub node_id: String,
    pub node_revision: u64,
    pub ledger_revision_id: String,
    pub content_hash: String,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct SpecPart {
    pub id: String,
    pub behaviour: String,
    #[serde(default)]
    pub design: String,
    #[serde(default)]
    pub implementation: String,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Criterion {
    pub id: String,
    pub text: String,
    #[serde(default = "goal_part")]
    pub part_id: String,
    #[serde(default)]
    pub verification: String,
}

fn goal_part() -> String {
    "GOAL".into()
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ChildCoverage {
    pub criterion_id: String,
    pub child_node_id: String,
    pub child_criterion_id: String,
    #[serde(default)]
    pub semantics: CoverageSemantics,
    #[serde(default)]
    pub justification: String,
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum CoverageSemantics {
    #[default]
    All,
    Any,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct SpecDraft {
    pub node_id: String,
    #[serde(default = "first_revision")]
    pub node_revision: u64,
    pub parent_id: Option<String>,
    pub concern_id: String,
    pub responsibility: String,
    pub kind: SpecKind,
    pub parts: Vec<SpecPart>,
    pub criteria: Vec<Criterion>,
    #[serde(default)]
    pub child_coverage: Vec<ChildCoverage>,
    #[serde(default)]
    pub source_refs: Vec<String>,
    #[serde(default)]
    pub decision_refs: Vec<String>,
    #[serde(default)]
    pub research_method: Option<ResearchMethod>,
    #[serde(default)]
    pub independent_review: bool,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ResearchMethod {
    pub questions: Vec<String>,
    pub hypotheses: Vec<String>,
    pub method: String,
    pub variables_controls: String,
    pub sampling_sources: String,
    pub analysis: String,
    pub falsification: String,
}

fn first_revision() -> u64 {
    1
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum SpecKind {
    Brief,
    Software,
    Research,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct WorkDraft {
    pub key: String,
    pub node_id: String,
    pub outcome: String,
    pub part_ids: Vec<String>,
    pub criterion_ids: Vec<String>,
}

#[derive(Clone, Copy, Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum TaskKind {
    #[default]
    Execute,
    Integrate,
    Review,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct TaskDraft {
    pub key: String,
    pub description: String,
    #[serde(default)]
    pub work_key: String,
    #[serde(default)]
    pub node_id: String,
    #[serde(default)]
    pub part_ids: Vec<String>,
    pub criterion_ids: Vec<String>,
    #[serde(default)]
    pub after: Vec<String>,
    #[serde(default)]
    pub kind: TaskKind,
    #[serde(default)]
    pub allow_nested_delegation: bool,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct InitialBundle {
    pub tier: u8,
    pub goal: String,
    pub root_node_id: String,
    pub nodes: Vec<SpecDraft>,
    pub works: Vec<WorkDraft>,
    pub tasks: Vec<TaskDraft>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct VerifiedSpec {
    pub reference: SpecRef,
    pub node: SpecDraft,
}

/// Ledger publication and exact integrity reads are required, never optional.
pub trait SpecPublication: Send + Sync {
    fn empty_installation(&self) -> PortFuture<'_, bool>;
    fn publish(
        &self,
        scope: String,
        instruction: String,
        key: String,
        nodes: Vec<SpecDraft>,
    ) -> PortFuture<'_, Vec<SpecRef>>;
    fn locate(
        &self,
        scope: String,
        instruction: String,
        node: String,
        revision: u64,
    ) -> PortFuture<'_, Option<VerifiedSpec>>;
    fn resolve(&self, scope: String, reference: SpecRef) -> PortFuture<'_, VerifiedSpec>;
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct WorkModelRequest {
    pub instruction_id: String,
    pub idempotency_key: String,
    pub expected_graph_revision: Option<u64>,
    pub command: WorkModelCommand,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(tag = "op", rename_all = "snake_case", deny_unknown_fields)]
pub enum WorkModelCommand {
    CreateLight {
        goal: String,
        done_criteria: Vec<Criterion>,
        tasks: Vec<TaskDraft>,
    },
    Create {
        bundle: InitialBundle,
    },
    Publish {
        nodes: Vec<SpecDraft>,
    },
    Activate {
        tier: u8,
        goal: String,
        root_node_id: String,
        published_refs: Vec<SpecRef>,
        works: Vec<WorkDraft>,
        tasks: Vec<TaskDraft>,
    },
    Start {
        task_id: String,
        expected_revision: u64,
    },
    Submit {
        task_id: String,
        expected_revision: u64,
        result_refs: Vec<String>,
        evidence_refs: Vec<String>,
    },
    Review {
        task_id: String,
        expected_revision: u64,
        result_revision: u64,
        criterion_results: Vec<CriterionResult>,
    },
    Complete {
        task_id: String,
        expected_revision: u64,
    },
    Remove {
        task_id: String,
        expected_revision: u64,
        #[serde(default)]
        remove_edges: Vec<Edge>,
    },
    Reorder {
        task_ids: Vec<String>,
    },
    Dependencies {
        add: Vec<Edge>,
        remove: Vec<Edge>,
    },
    Step {
        task_id: String,
        phase: String,
    },
    CompleteWork {
        work_id: String,
    },
    CompletePlan,
    ResolveDraft {
        task_id: String,
        expected_revision: u64,
        criterion_ids: Vec<String>,
        #[serde(default)]
        question: bool,
    },
    Add {
        work_id: String,
        spec_ref: SpecRef,
        task: TaskDraft,
    },
    Edit {
        task_id: String,
        expected_revision: u64,
        description: String,
    },
    Batch {
        operations: Vec<WorkModelCommand>,
        expected_control_epoch: u64,
        reason: String,
    },
    Block {
        task_id: String,
        expected_revision: u64,
        reason: String,
    },
    SessionStop,
    SessionPause,
    SessionResume,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Edge {
    pub from: String,
    pub to: String,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct CriterionResult {
    pub criterion_id: String,
    pub verdict: Verdict,
    pub evidence_refs: Vec<String>,
    pub reason: String,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Verdict {
    Pass,
    Fail,
    Unverified,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct TaskCard {
    pub id: String,
    pub scope: serde_json::Value,
    pub title: String,
    pub origin_instruction_id: String,
    pub author: String,
    pub created_at: String,
    pub updated_at: String,
    pub work_id: String,
    pub spec_ref: SpecRef,
    pub description: String,
    pub kind: TaskKind,
    #[serde(default)]
    pub allow_nested_delegation: bool,
    pub part_ids: Vec<String>,
    pub criterion_ids: Vec<String>,
    pub rank: i64,
    pub status: String,
    pub revision: u64,
    pub result_revision: u64,
    pub assignee_session_id: Option<String>,
    pub result_refs: Vec<String>,
    pub evidence_refs: Vec<String>,
    pub review_id: Option<String>,
    pub blocked_reason: Option<String>,
}

#[derive(Clone, Debug)]
pub struct Creation {
    pub bundle: InitialBundle,
    pub verified: Vec<VerifiedSpec>,
}

pub fn decode_request(value: serde_json::Value) -> Result<WorkModelRequest, BtccError> {
    serde_json::from_value(value)
        .map_err(|source| super::error("work_model_command_invalid").with_source(source))
}
