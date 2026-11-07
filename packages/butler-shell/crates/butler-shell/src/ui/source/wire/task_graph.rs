//! Wire types for the P2 wave-2 `task_graph` unit (mirror TS, `/// TS: path:line`).
use serde::Deserialize;

/// TS: packages/butler-app/shared/task-graph-contracts.ts:3 TaskGraphStatus
#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "snake_case")]
pub(crate) enum TaskGraphStatusWire {
    Pending,
    Running,
    Review,
    Done,
    Skipped,
    Failed,
    Blocked,
    Paused,
    Cancelled,
    #[serde(other)]
    Unknown,
}

/// TS: packages/butler-app/shared/task-graph-contracts.ts:4 TaskGraphState
#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "snake_case")]
pub(crate) enum TaskGraphStateWire {
    Running,
    Failed,
    Waiting,
    Done,
    Cancelled,
    #[serde(other)]
    Unknown,
}

/// TS: packages/butler-app/shared/task-graph-contracts.ts:20 TaskGraphPhase
#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "snake_case")]
pub(crate) enum TaskGraphPhaseWire {
    Conception,
    Planning,
    Execution,
    Review,
    Validation,
    Reporting,
    #[serde(other)]
    Unknown,
}

/// TS: packages/butler-app/shared/task-graph-contracts.ts:62 TaskGraphSummary (work_state)
#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "snake_case")]
pub(crate) enum TaskGraphWorkStateWire {
    Open,
    Blocked,
    Completed,
    Abandoned,
    #[serde(other)]
    Unknown,
}

/// TS: packages/butler-app/shared/task-graph-contracts.ts:5 TaskGraphCounts
#[derive(Debug, Clone, Default, PartialEq, Deserialize)]
pub(crate) struct TaskGraphCountsWire {
    #[serde(default)]
    pub(crate) total: u64,
    #[serde(default)]
    pub(crate) completed: u64,
    #[serde(default)]
    pub(crate) running: u64,
    #[serde(default)]
    pub(crate) failed: u64,
    #[serde(default)]
    pub(crate) blocked: u64,
    #[serde(default)]
    pub(crate) cancelled: u64,
    #[serde(default)]
    pub(crate) skipped: u64,
}

/// TS: packages/butler-app/shared/task-graph-contracts.ts:13 TaskDocumentRef
#[derive(Debug, Clone, PartialEq, Deserialize)]
pub(crate) struct TaskDocumentRefWire {
    pub(crate) id: String,
    pub(crate) revision: String,
    pub(crate) title: String,
    pub(crate) status: TaskGraphStatusWire,
    #[serde(default)]
    pub(crate) source_label: String,
}

/// TS: packages/butler-app/shared/task-graph-contracts.ts:22 TaskGraphReview
#[derive(Debug, Clone, PartialEq, Deserialize)]
pub(crate) struct TaskGraphReviewWire {
    pub(crate) subject: String,
    pub(crate) verdict: String,
    pub(crate) summary: String,
    pub(crate) created_at: String,
}

/// TS: packages/butler-app/shared/task-graph-contracts.ts:28 TaskGraphAttempt
#[derive(Debug, Clone, PartialEq, Deserialize)]
pub(crate) struct TaskGraphAttemptWire {
    pub(crate) task_id: String,
    pub(crate) session_id: String,
    pub(crate) ordinal: u64,
    pub(crate) status: String,
    #[serde(default)]
    pub(crate) summary: Option<String>,
    #[serde(default)]
    pub(crate) model_display_name: Option<String>,
    #[serde(default)]
    pub(crate) started_at: Option<String>,
    #[serde(default)]
    pub(crate) finished_at: Option<String>,
}

/// TS: packages/butler-app/shared/task-graph-contracts.ts:38 TaskGraphNode (reason_code)
#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "snake_case")]
pub(crate) enum TaskGraphReasonWire {
    ActionBlocked,
    AttemptFailed,
    ResultReceived,
    ReviewRevised,
    WorkAbandoned,
    #[serde(other)]
    Unknown,
}

/// TS: packages/butler-app/shared/task-graph-contracts.ts:38 TaskGraphNode
#[derive(Debug, Clone, PartialEq, Deserialize)]
pub(crate) struct TaskGraphNodeWire {
    pub(crate) task_id: String,
    pub(crate) title: String,
    pub(crate) status: TaskGraphStatusWire,
    #[serde(default)]
    pub(crate) rank: i64,
    #[serde(default)]
    pub(crate) assignee_ordinal: Option<u64>,
    #[serde(default)]
    pub(crate) model_display_name: Option<String>,
    #[serde(default)]
    pub(crate) session_id: Option<String>,
    #[serde(default)]
    pub(crate) started_at: Option<String>,
    #[serde(default)]
    pub(crate) finished_at: Option<String>,
    #[serde(default)]
    pub(crate) current_step: Option<String>,
    #[serde(default)]
    pub(crate) blocked_reason: Option<String>,
    #[serde(default)]
    pub(crate) reason_code: Option<TaskGraphReasonWire>,
    #[serde(default)]
    pub(crate) handled_directly: bool,
    #[serde(default)]
    pub(crate) attempts: Vec<TaskGraphAttemptWire>,
    #[serde(default)]
    pub(crate) review: Option<TaskGraphReviewWire>,
    pub(crate) document: TaskDocumentRefWire,
}

/// TS: packages/butler-app/shared/task-graph-contracts.ts:62 TaskGraphSnapshot (edges)
#[derive(Debug, Clone, PartialEq, Deserialize)]
pub(crate) struct TaskGraphEdgeWire {
    pub(crate) from: String,
    pub(crate) to: String,
}

/// TS: packages/butler-app/shared/task-graph-contracts.ts:53 TaskGraphSummary
#[derive(Debug, Clone, PartialEq, Deserialize)]
pub(crate) struct TaskGraphSummaryWire {
    pub(crate) graph_id: String,
    pub(crate) phase: TaskGraphPhaseWire,
    pub(crate) work_state: TaskGraphWorkStateWire,
    pub(crate) title: String,
    pub(crate) state: TaskGraphStateWire,
    pub(crate) counts: TaskGraphCountsWire,
    pub(crate) graph_revision: String,
    pub(crate) updated_at: String,
}

/// TS: packages/butler-app/shared/task-graph-contracts.ts:63 TaskGraphsPage
#[derive(Debug, Clone, PartialEq, Deserialize)]
pub(crate) struct TaskGraphsPageWire {
    #[serde(default)]
    pub(crate) graphs: Vec<TaskGraphSummaryWire>,
    #[serde(default)]
    pub(crate) cursor: Option<String>,
    pub(crate) graph_revision: String,
    #[serde(default)]
    pub(crate) total: u64,
    #[serde(default)]
    pub(crate) event_seq: i64,
}

/// TS: packages/butler-app/shared/task-graph-contracts.ts:70 TaskGraphSnapshot (totals)
#[derive(Debug, Clone, Default, PartialEq, Deserialize)]
pub(crate) struct TaskGraphTotalsWire {
    #[serde(default)]
    pub(crate) nodes: u64,
    #[serde(default)]
    pub(crate) edges: u64,
}

/// TS: packages/butler-app/shared/task-graph-contracts.ts:70 TaskGraphSnapshot
#[derive(Debug, Clone, PartialEq, Deserialize)]
pub(crate) struct TaskGraphSnapshotWire {
    #[serde(flatten)]
    pub(crate) summary: TaskGraphSummaryWire,
    #[serde(default)]
    pub(crate) nodes: Vec<TaskGraphNodeWire>,
    #[serde(default)]
    pub(crate) edges: Vec<TaskGraphEdgeWire>,
    #[serde(default)]
    pub(crate) totals: TaskGraphTotalsWire,
    #[serde(default)]
    pub(crate) cursor: Option<String>,
    #[serde(default)]
    pub(crate) event_seq: i64,
}

/// TS: packages/butler-app/shared/task-graph-contracts.ts:94 TaskGraphPatch (entity_changes)
#[derive(Debug, Clone, PartialEq, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub(crate) enum TaskGraphEntityChangeWire {
    Upsert {
        task_id: String,
        node: Box<TaskGraphNodeWire>,
    },
    Remove {
        task_id: String,
    },
}

/// TS: packages/butler-app/shared/task-graph-contracts.ts:85 TaskGraphChanged (a patch or a
/// removal; the fields only a patch carries are optional).
#[derive(Debug, Clone, PartialEq, Deserialize)]
pub(crate) struct TaskGraphChangedWire {
    pub(crate) session_id: String,
    pub(crate) plan_id: String,
    pub(crate) graph_revision: String,
    #[serde(default)]
    pub(crate) previous_graph_revision: Option<String>,
    #[serde(default)]
    pub(crate) entity_changes: Vec<TaskGraphEntityChangeWire>,
    #[serde(default)]
    pub(crate) edges: Vec<TaskGraphEdgeWire>,
    #[serde(default)]
    pub(crate) title: Option<String>,
    #[serde(default)]
    pub(crate) state: Option<TaskGraphStateWire>,
    #[serde(default)]
    pub(crate) updated_at: Option<String>,
    #[serde(default)]
    pub(crate) counts: Option<TaskGraphCountsWire>,
    #[serde(default)]
    pub(crate) event_seq: i64,
    #[serde(default)]
    pub(crate) refetch: bool,
    #[serde(default)]
    pub(crate) phase: Option<TaskGraphPhaseWire>,
    #[serde(default)]
    pub(crate) work_state: Option<TaskGraphWorkStateWire>,
    #[serde(default)]
    pub(crate) node_order: Option<Vec<String>>,
    #[serde(default)]
    pub(crate) removed: bool,
}

/// TS: packages/butler-app/shared/task-graph-contracts.ts:115 TaskGraphDocument (and the fields
/// of `ProjectDashboardDocument`, app/types.ts:1382, the task document dialog reads).
#[derive(Debug, Clone, PartialEq, Deserialize)]
pub(crate) struct TaskGraphDocumentWire {
    pub(crate) id: String,
    pub(crate) title: String,
    #[serde(default)]
    pub(crate) markdown: String,
    #[serde(default)]
    pub(crate) source_label: String,
}
