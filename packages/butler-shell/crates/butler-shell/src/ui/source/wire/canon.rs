//! Canon gateway contracts (shared/canon-contracts.ts): the board, the plan and epic details,
//! tags, activity and specs (the plan and epic inputs are in `canon_input.rs`). Entity
//! revisions are numeric CAS tokens.
use std::collections::BTreeMap;

use serde::{Deserialize, Serialize};

use super::CanonQueueCounts;

/// TS: packages/butler-app/client/shared/canon-contracts.ts:4 CanonStatus
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Deserialize, Serialize)]
#[serde(rename_all = "snake_case")]
pub(crate) enum CanonStatus {
    Planned,
    InProgress,
    InReview,
    Blocked,
    Done,
    Cancelled,
    #[serde(other, skip_serializing)]
    Unknown,
}

/// TS: packages/butler-app/client/shared/canon-contracts.ts:5 WorkTaskStatus
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Deserialize)]
#[serde(rename_all = "snake_case")]
pub(crate) enum WorkTaskStatus {
    Draft,
    Waiting,
    Pending,
    Running,
    InReview,
    Held,
    Failed,
    Completed,
    Blocked,
    Paused,
    Stopped,
    Cancelled,
    #[serde(other)]
    Unknown,
}

/// TS: packages/butler-app/client/shared/canon-contracts.ts:6 TaskCounts (`total` plus a count
/// per `WorkTaskStatus` name).
#[derive(Debug, Clone, PartialEq, Deserialize)]
pub(crate) struct TaskCounts {
    pub(crate) total: i64,
    #[serde(flatten)]
    pub(crate) statuses: BTreeMap<String, i64>,
}

/// TS: packages/butler-app/client/shared/canon-contracts.ts:7 CanonTagColor
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Deserialize, Serialize)]
#[serde(rename_all = "snake_case")]
pub(crate) enum CanonTagColor {
    Gray,
    Red,
    Orange,
    Yellow,
    Green,
    Teal,
    Blue,
    Purple,
    #[serde(other, skip_serializing)]
    Unknown,
}

/// TS: packages/butler-app/client/shared/canon-contracts.ts:8 EpicTag
#[derive(Debug, Clone, PartialEq, Deserialize)]
pub(crate) struct EpicTag {
    pub(crate) id: String,
    pub(crate) name: String,
    pub(crate) color: CanonTagColor,
}

/// TS: packages/butler-app/client/shared/canon-contracts.ts:9 CanonTag (extends EpicTag)
#[derive(Debug, Clone, PartialEq, Deserialize)]
pub(crate) struct CanonTag {
    #[serde(flatten)]
    pub(crate) tag: EpicTag,
    pub(crate) project_id: String,
    pub(crate) name_key: String,
    pub(crate) revision: i64,
    pub(crate) created_at: i64,
    pub(crate) updated_at: i64,
    pub(crate) created_by: String,
}

/// TS: packages/butler-app/client/shared/canon-contracts.ts:17 CanonTagCreateInput
#[derive(Debug, Clone, PartialEq, Serialize)]
pub(crate) struct CanonTagCreateInput {
    pub(crate) name: String,
    pub(crate) color: CanonTagColor,
}

/// TS: packages/butler-app/client/shared/canon-contracts.ts:18 CanonTagEditInput
#[derive(Debug, Clone, PartialEq, Serialize)]
pub(crate) struct CanonTagEditInput {
    pub(crate) expected_revision: i64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) name: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) color: Option<CanonTagColor>,
}

/// TS: packages/butler-app/client/shared/canon-contracts.ts:20 CanonAgent
#[derive(Debug, Clone, PartialEq, Deserialize)]
pub(crate) struct CanonAgent {
    pub(crate) person: String,
    pub(crate) via: String,
}

/// TS: packages/butler-app/client/shared/canon-contracts.ts:21 CanonActor
#[derive(Debug, Clone, PartialEq, Deserialize)]
pub(crate) struct CanonActor {
    #[serde(default)]
    pub(crate) person: Option<String>,
    #[serde(default)]
    pub(crate) via: Option<String>,
    #[serde(default)]
    pub(crate) origin: Option<String>,
    #[serde(default)]
    pub(crate) client: Option<String>,
}

/// TS: packages/butler-app/client/shared/canon-contracts.ts:22 CanonActivity
#[derive(Debug, Clone, PartialEq, Deserialize)]
pub(crate) struct CanonActivity {
    pub(crate) seq: i64,
    pub(crate) entity_id: String,
    pub(crate) kind: String,
    #[serde(default)]
    pub(crate) from: Option<CanonStatus>,
    #[serde(default)]
    pub(crate) to: Option<CanonStatus>,
    pub(crate) summary: String,
    #[serde(default)]
    pub(crate) body: Option<String>,
    pub(crate) actor: CanonActor,
    pub(crate) at: i64,
}

/// TS: packages/butler-app/client/shared/canon-contracts.ts:23 CanonActivityPage
#[derive(Debug, Clone, PartialEq, Deserialize)]
pub(crate) struct CanonActivityPage {
    pub(crate) activity: Vec<CanonActivity>,
    #[serde(default)]
    pub(crate) activity_before: Option<i64>,
}

/// TS: packages/butler-app/client/shared/canon-contracts.ts:24 CanonMcpProposal
#[derive(Debug, Clone, PartialEq, Deserialize)]
pub(crate) struct CanonMcpProposal {
    pub(crate) id: String,
    pub(crate) spec_id: String,
    pub(crate) summary: String,
    #[serde(default)]
    pub(crate) current_body: Option<String>,
    pub(crate) proposed_body: String,
    pub(crate) actor: CanonActor,
    pub(crate) base_revision: i64,
    pub(crate) created_at: String,
}

/// TS: packages/butler-app/client/shared/canon-contracts.ts:25 CriteriaCount
#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
pub(crate) struct CriteriaCount {
    pub(crate) confirmed: i64,
    pub(crate) total: i64,
}

/// TS: packages/butler-app/client/shared/canon-contracts.ts:37 CanonWork (inline sessions).
#[derive(Debug, Clone, PartialEq, Deserialize)]
pub(crate) struct CanonSessionBinding {
    pub(crate) session_id: String,
    pub(crate) bound_at: i64,
    /// "user" | "butler"
    pub(crate) origin: String,
}

/// TS: packages/butler-app/client/shared/canon-contracts.ts:53 EpicCard (inline queue): its
/// place in its home conversation's queue; `hold` marks a step waiting on a decision.
#[derive(Debug, Clone, PartialEq, Deserialize)]
pub(crate) struct EpicQueue {
    /// "waiting" | "running" | "held" | "done"
    pub(crate) state: String,
    pub(crate) hold: bool,
    pub(crate) finished_at: Option<i64>,
}

/// TS: packages/butler-app/client/shared/canon-contracts.ts:26 CanonWork + :48 EpicCard. The
/// sidebar reads a subset of the same rows, so the fields it never gets are defaulted.
#[derive(Debug, Clone, PartialEq, Deserialize)]
pub(crate) struct EpicCard {
    #[serde(default)]
    pub(crate) criteria: Option<CriteriaCount>,
    #[serde(default)]
    pub(crate) agent: Option<CanonAgent>,
    #[serde(default)]
    pub(crate) tags: Vec<EpicTag>,
    pub(crate) id: String,
    pub(crate) project_id: String,
    pub(crate) plan_id: Option<String>,
    pub(crate) home_session_id: Option<String>,
    #[serde(default)]
    pub(crate) session_ids: Vec<String>,
    #[serde(default)]
    pub(crate) sessions: Vec<CanonSessionBinding>,
    pub(crate) title: String,
    pub(crate) description: String,
    #[serde(default)]
    pub(crate) kind: Option<String>,
    pub(crate) canon_status: CanonStatus,
    /// "runtime" | "person"
    #[serde(default)]
    pub(crate) canon_status_source: Option<String>,
    pub(crate) assignee: Option<String>,
    #[serde(default)]
    pub(crate) plan_rank: Option<String>,
    /// "chat" | "dialog" | "board" | "mcp"
    #[serde(default)]
    pub(crate) origin: Option<String>,
    pub(crate) revision: i64,
    #[serde(default)]
    pub(crate) task_counts: Option<TaskCounts>,
    #[serde(default)]
    pub(crate) running: bool,
    #[serde(default)]
    pub(crate) delete_blocked: Option<bool>,
    pub(crate) queue: Option<EpicQueue>,
}

/// TS: packages/butler-app/client/shared/canon-contracts.ts:55 CanonPlan
#[derive(Debug, Clone, PartialEq, Deserialize)]
pub(crate) struct CanonPlan {
    #[serde(default)]
    pub(crate) updated_at: Option<i64>,
    pub(crate) id: String,
    pub(crate) project_id: String,
    pub(crate) title: String,
    pub(crate) description: String,
    pub(crate) due_on: Option<String>,
    /// "open" | "closed"
    pub(crate) status: String,
    pub(crate) revision: i64,
}

/// TS: packages/butler-app/client/shared/canon-contracts.ts:65 PlanCards
#[derive(Debug, Clone, PartialEq, Deserialize)]
pub(crate) struct PlanCards {
    #[serde(flatten)]
    pub(crate) plan: CanonPlan,
    #[serde(default)]
    pub(crate) works: Vec<EpicCard>,
}

/// TS: packages/butler-app/client/shared/canon-contracts.ts:66 CanonOverview
#[derive(Debug, Clone, PartialEq, Deserialize)]
pub(crate) struct CanonOverview {
    pub(crate) project_id: String,
    pub(crate) backlog_revision: i64,
    pub(crate) backlog: Vec<EpicCard>,
    pub(crate) plans: Vec<PlanCards>,
}

/// TS: packages/butler-app/client/shared/canon-contracts.ts:72 PlanDetail (inline progress).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
pub(crate) struct PlanProgress {
    pub(crate) total: i64,
    pub(crate) done: i64,
}

/// TS: packages/butler-app/client/shared/canon-contracts.ts:72 PlanDetail
#[derive(Debug, Clone, PartialEq, Deserialize)]
pub(crate) struct PlanDetail {
    #[serde(flatten)]
    pub(crate) cards: PlanCards,
    pub(crate) progress: PlanProgress,
}

/// TS: packages/butler-app/client/shared/canon-contracts.ts:73 SpecCriterion
#[derive(Debug, Clone, PartialEq, Deserialize)]
pub(crate) struct SpecCriterion {
    pub(crate) confirmed: bool,
    pub(crate) node_id: String,
    pub(crate) revision: i64,
    pub(crate) criterion_id: String,
    pub(crate) part_id: String,
    pub(crate) text: String,
}

/// TS: packages/butler-app/client/shared/canon-contracts.ts:89 SpecNode (inline active).
#[derive(Debug, Clone, PartialEq, Deserialize)]
pub(crate) struct SpecNodeActive {
    pub(crate) node_id: String,
    pub(crate) revision: i64,
    pub(crate) body_hash: String,
    pub(crate) parser_version: String,
    pub(crate) state: String,
}

/// TS: packages/butler-app/client/shared/canon-contracts.ts:81 SpecNode
#[derive(Debug, Clone, PartialEq, Deserialize)]
pub(crate) struct SpecNode {
    pub(crate) revision: i64,
    #[serde(default)]
    pub(crate) latest_revision: Option<i64>,
    pub(crate) node_id: String,
    pub(crate) parent_node_id: Option<String>,
    pub(crate) concern_id: String,
    pub(crate) active_revision: Option<i64>,
    /// "draft" | "active" | "retired"
    pub(crate) lifecycle: String,
    pub(crate) active: Option<SpecNodeActive>,
    #[serde(default)]
    pub(crate) criteria: Vec<SpecCriterion>,
    #[serde(default)]
    pub(crate) children: Vec<SpecNode>,
}

/// TS: packages/butler-app/client/shared/canon-contracts.ts:93 WorkTask
#[derive(Debug, Clone, PartialEq, Deserialize)]
pub(crate) struct WorkTask {
    pub(crate) id: String,
    pub(crate) work_id: String,
    pub(crate) title: String,
    pub(crate) description: String,
    pub(crate) status: WorkTaskStatus,
    pub(crate) assignee_session_id: Option<String>,
    pub(crate) blocked_reason: Option<String>,
    pub(crate) chain_id: Option<String>,
    pub(crate) step_index: Option<i64>,
    pub(crate) stack_position: Option<i64>,
    /// "predecessor_failed" | "predecessor_stopped"
    pub(crate) hold_reason: Option<String>,
    pub(crate) failure_reason: Option<String>,
    pub(crate) revision: i64,
}

/// TS: packages/butler-app/client/shared/canon-contracts.ts:108 CanonAttachment
#[derive(Debug, Clone, PartialEq, Deserialize)]
pub(crate) struct CanonAttachment {
    pub(crate) file_id: String,
    /// "image" | "text" | "generic"
    pub(crate) kind: String,
    pub(crate) mime_type: String,
    pub(crate) safe_name: String,
    pub(crate) size_bytes: i64,
    pub(crate) sha256: String,
    pub(crate) url: String,
    #[serde(default)]
    pub(crate) signed_url: Option<String>,
    pub(crate) created_at: String,
    #[serde(default)]
    pub(crate) width: Option<i64>,
    #[serde(default)]
    pub(crate) height: Option<i64>,
}

/// TS: packages/butler-app/client/shared/canon-contracts.ts:113 EpicDetail (extends EpicCard)
#[derive(Debug, Clone, PartialEq, Deserialize)]
pub(crate) struct EpicDetail {
    #[serde(flatten)]
    pub(crate) card: EpicCard,
    #[serde(default)]
    pub(crate) activity: Option<Vec<CanonActivity>>,
    #[serde(default)]
    pub(crate) activity_before: Option<i64>,
    #[serde(default)]
    pub(crate) proposals: Option<Vec<CanonMcpProposal>>,
    #[serde(default)]
    pub(crate) attachments: Option<Vec<CanonAttachment>>,
    #[serde(default)]
    pub(crate) specs: Vec<SpecNode>,
    #[serde(default)]
    pub(crate) tasks: Vec<WorkTask>,
}

/// TS: packages/butler-app/client/shared/canon-contracts.ts:118 EpicProgressSnapshot (inline
/// stage_history).
#[derive(Debug, Clone, PartialEq, Deserialize)]
pub(crate) struct EpicStageEntry {
    pub(crate) work_id: String,
    pub(crate) revision: i64,
    pub(crate) stage: String,
    pub(crate) summary: String,
    pub(crate) created_at: String,
}

/// TS: packages/butler-app/client/shared/canon-contracts.ts:119 EpicProgressSnapshot (inline
/// actions).
#[derive(Debug, Clone, PartialEq, Deserialize)]
pub(crate) struct EpicProgressAction {
    pub(crate) work_id: String,
    #[serde(rename = "actionKey")]
    pub(crate) action_key: String,
    pub(crate) description: String,
    #[serde(rename = "dependencyKeys", default)]
    pub(crate) dependency_keys: Vec<String>,
    /// "pending" | "active" | "done" | "blocked" | "skipped"
    pub(crate) status: String,
    #[serde(default)]
    pub(crate) note: Option<String>,
}

/// TS: packages/butler-app/client/shared/canon-contracts.ts:114 EpicProgressSnapshot
#[derive(Debug, Clone, PartialEq, Deserialize)]
pub(crate) struct EpicProgressSnapshot {
    pub(crate) epic_id: String,
    pub(crate) running: bool,
    /// "conception" | "planning" | "execution" | "review" | "validation" | "reporting"
    pub(crate) stage: Option<String>,
    #[serde(default)]
    pub(crate) stage_history: Vec<EpicStageEntry>,
    #[serde(default)]
    pub(crate) actions: Vec<EpicProgressAction>,
    /// "open" | "blocked" | "completed"
    pub(crate) disposition: Option<String>,
    pub(crate) counts: CanonQueueCounts,
}

/// TS: packages/butler-app/client/shared/canon-contracts.ts:141 CanonProgressChanged
#[derive(Debug, Clone, PartialEq, Deserialize)]
pub(crate) struct CanonProgressChanged {
    pub(crate) project_id: String,
    pub(crate) epic_id: String,
}

/// TS: packages/butler-app/client/shared/canon-contracts.ts:142 CanonChanged
#[derive(Debug, Clone, PartialEq, Deserialize)]
pub(crate) struct CanonChanged {
    pub(crate) project_id: String,
    /// "plan" | "backlog" | "work" | "spec_node" | "tag"
    pub(crate) kind: String,
    pub(crate) id: String,
    pub(crate) revision: i64,
    /// "local" | "remote" | "mcp" | "butler"
    pub(crate) origin: String,
    pub(crate) event_seq: i64,
}

/// TS: packages/butler-app/client/shared/canon-contracts.ts:164 CanonConversation
#[derive(Debug, Clone, PartialEq, Deserialize)]
pub(crate) struct CanonConversation {
    pub(crate) session_id: String,
    pub(crate) work: EpicDetail,
}
