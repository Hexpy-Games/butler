//! Closed, model-authored operation vocabulary. Identity and grants come from
//! the runtime, never from this payload.
use super::execution::{CriterionRef, CriterionResult};
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Apply {
    pub reason: String,
    pub spec_ref: Option<SpecRef>,
    pub expected_task_graph_revision: Option<i64>,
    #[serde(default)]
    pub expected_revisions: BTreeMap<String, i64>,
    pub operations: Vec<Operation>,
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct SpecRef {
    pub node_id: String,
    pub revision: i64,
    pub body_hash: String,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct TaskDraft {
    pub key: Option<String>,
    pub title: String,
    pub description: String,
    pub criteria: Option<Vec<usize>>,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct TaskPatch {
    pub title: Option<String>,
    pub description: Option<String>,
    pub acceptance_refs: Option<Vec<CriterionRef>>,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct PartPatch {
    pub title: Option<String>,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct SpecDraft {
    pub title: String,
    pub goal: String,
    pub criteria: Vec<String>,
    pub constraints: Vec<String>,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "op", deny_unknown_fields)]
pub enum Operation {
    #[serde(rename = "work.create_light")]
    CreateLight {
        tier: Option<u8>,
        key: Option<String>,
        goal: String,
        done_criteria: Vec<String>,
        tasks: Vec<Vec<TaskDraft>>,
    },
    #[serde(rename = "work.escalate")]
    Escalate { tier: u8, reason: String },
    #[serde(rename = "task.add")]
    Add {
        key: Option<String>,
        title: String,
        description: String,
        after_task_id: Option<String>,
        join_step_of_task_id: Option<String>,
        step: Option<String>,
        acceptance_refs: Option<Vec<CriterionRef>>,
    },
    #[serde(rename = "task.edit")]
    Edit {
        task_id: String,
        patch: TaskPatch,
        confirm_draft: Option<bool>,
    },
    #[serde(rename = "task.move")]
    Move {
        task_id: String,
        after_task_id: Option<String>,
        join_step_of_task_id: Option<String>,
        step: Option<String>,
    },
    #[serde(rename = "task.join_stack")]
    JoinStack {
        task_id: String,
        into_step_of_task_id: String,
    },
    #[serde(rename = "task.split_stack")]
    SplitStack {
        task_id: String,
        order: Option<Vec<String>>,
    },
    #[serde(rename = "task.delete")]
    Delete { task_id: String, reason: String },
    #[serde(rename = "part.add")]
    PartAdd {
        key: Option<String>,
        task_id: String,
        kind: super::super::work_types::TaskKind,
        title: String,
        after_part_ids: Option<Vec<String>>,
    },
    #[serde(rename = "part.edit")]
    PartEdit {
        part_id: String,
        patch: PartPatch,
        after_part_ids: Option<Vec<String>>,
    },
    #[serde(rename = "part.remove")]
    PartRemove { part_id: String, reason: String },
    #[serde(rename = "task.start")]
    Start { task_id: String },
    #[serde(rename = "part.start")]
    PartStart { part_id: String },
    #[serde(rename = "task.submit")]
    Submit {
        task_id: String,
        part_id: Option<String>,
        result_refs: Vec<String>,
        evidence_refs: Vec<String>,
    },
    #[serde(rename = "task.review")]
    Review {
        key: Option<String>,
        task_id: String,
        result_revision: i64,
        verdict: Verdict,
        criterion_results: Vec<CriterionResult>,
    },
    #[serde(rename = "task.complete")]
    Complete { task_id: String, review_ref: String },
    #[serde(rename = "task.block")]
    Block {
        task_id: String,
        part_id: Option<String>,
        reason: String,
        checkpoint_ref: Option<String>,
    },
    #[serde(rename = "task.fail")]
    Fail { task_id: String, reason: String },
    #[serde(rename = "spec.propose")]
    Propose {
        key: Option<String>,
        node_id: Option<String>,
        base_revision: Option<i64>,
        node: SpecDraft,
    },
    #[serde(rename = "spec.activate")]
    Activate {
        published_refs: Vec<SpecRef>,
        expected_tree_version: i64,
        impact_map: Option<ImpactMap>,
    },
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ImpactMap {
    pub tasks: Vec<TaskImpact>,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct TaskImpact {
    pub task_id: String,
    pub expected_revision: i64,
    pub acceptance_refs: Vec<CriterionRef>,
    pub corrective: Option<CorrectiveDraft>,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct CorrectiveDraft {
    pub title: String,
    pub description: String,
}
#[derive(Debug, Clone, Copy, Serialize, Deserialize)]
pub enum Verdict {
    #[serde(rename = "accept")]
    Accept,
    #[serde(rename = "revise")]
    Revise,
}
impl Operation {
    pub fn structure(&self) -> bool {
        matches!(
            self,
            Self::Activate {
                impact_map: Some(_),
                ..
            } | Self::Escalate { .. }
                | Self::Add { .. }
                | Self::Edit { .. }
                | Self::Move { .. }
                | Self::JoinStack { .. }
                | Self::SplitStack { .. }
                | Self::Delete { .. }
                | Self::PartAdd { .. }
                | Self::PartEdit { .. }
                | Self::PartRemove { .. }
        )
    }
    pub fn execution(&self) -> bool {
        matches!(
            self,
            Self::Start { .. }
                | Self::PartStart { .. }
                | Self::Submit { .. }
                | Self::Review { .. }
                | Self::Complete { .. }
                | Self::Block { .. }
                | Self::Fail { .. }
        )
    }
}
