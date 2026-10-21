//! Request-path reads. Predicates intentionally repeat partial-index predicates.
//! Parameters are positional, scoped first, with keyset cursors where applicable.

pub const CHAT_QUEUE: &str = "SELECT id,graph_revision,state,created_at FROM wm_work_chains
 WHERE session_id=?1 AND state=?2 ORDER BY created_at,id";
/// Stable first columns allow callers to reconstruct and validate membership.
pub const CHAIN_MEMBERS: &str = "SELECT id,step_index,stack_position,run_state,result_reported_at
 FROM wm_works WHERE chain_id=?1 ORDER BY step_index,stack_position";
pub const READINESS: &str = "SELECT pred_work_id FROM wm_work_edges WHERE succ_work_id=?1";
pub const HOLD_DECISIONS: &str =
    "SELECT * FROM wm_hold_decisions WHERE chain_id=?1 AND decision IS NULL";
pub const CONVERSATION_WORK: &str = "SELECT * FROM wm_works WHERE home_session_id=?1
 AND visibility='canon' AND home_session_id IS NOT NULL";
pub const PLAN_OVERVIEW: &str =
    "SELECT * FROM wm_works WHERE plan_id=?1 AND visibility='canon' ORDER BY plan_rank";
pub const BACKLOG: &str = "SELECT * FROM wm_works WHERE scope_ref=?1 AND visibility='canon'
 AND plan_id IS NULL ORDER BY plan_rank";
pub const PLAN_LIST: &str =
    "SELECT * FROM wm_plans WHERE project_id=?1 AND status=?2 ORDER BY due_on";
pub const TASK_LIST: &str = "SELECT * FROM wm_tasks WHERE work_id=?1 ORDER BY task_rank";
pub const TASK_PROGRESS: &str =
    "SELECT status,count(*) FROM wm_tasks WHERE work_id=?1 GROUP BY status";
pub const PENDING_INSTRUCTIONS: &str = "SELECT * FROM wm_instructions WHERE target_session_id=?1
 AND status IN ('accepted','waiting_for_turn','waiting_for_task','pending_safe_point') ORDER BY received_seq";
pub const RUNNING_ATTEMPTS: &str =
    "SELECT * FROM wm_attempts WHERE session_id=?1 AND status='running'";
pub const UNPUBLISHED_OUTBOX: &str =
    "SELECT * FROM wm_outbox WHERE published=0 AND seq>?1 ORDER BY seq LIMIT ?2";
pub const PENDING_INTENTS: &str =
    "SELECT * FROM wm_cross_db_intents WHERE state='pending' AND op_id>?1 ORDER BY op_id LIMIT ?2";
pub const LEGACY_LOOKUP: &str = "SELECT new_id,source_hash,imported_revision,batch FROM wm_legacy_map WHERE source=?1 AND source_id=?2";
pub const SPEC_CHILDREN: &str = "SELECT * FROM wm_spec_nodes WHERE parent_node_id=?1";
pub const SCOPED_WORKS: &str = "SELECT * FROM wm_works WHERE scope_kind=?1 AND scope_ref=?2 AND visibility=?3 AND run_state=?4";
pub const CHAIN_EDGES: &str = "SELECT pred_work_id,succ_work_id FROM wm_work_edges WHERE chain_id=?1 ORDER BY pred_work_id,succ_work_id";
pub const TASK_PREDECESSORS: &str = "SELECT pred FROM wm_task_edges WHERE work_id=?1 AND succ=?2";
pub const CRITERION_CONSUMERS: &str = "SELECT task_id FROM wm_task_criteria WHERE node_id=?1 AND node_revision=?2 AND criterion_id=?3";
pub const WORK_SPEC_NODES: &str = "SELECT * FROM wm_spec_nodes WHERE work_id=?1";
pub const TASK_LEASE: &str = "SELECT * FROM wm_attempts WHERE task_id=?1 AND status='running'";

/// SQL/index pairs shared by format pins and deployed-schema verification.
pub const INDEXED_READS: &[(&str, &str)] = &[
    (CHAT_QUEUE, "wm_work_chains_queue"),
    (CHAIN_MEMBERS, "wm_works_chain"),
    (READINESS, "wm_work_edges_successor"),
    (HOLD_DECISIONS, "wm_hold_decisions_pending"),
    (CONVERSATION_WORK, "wm_works_home"),
    (PLAN_OVERVIEW, "wm_works_plan"),
    (BACKLOG, "wm_works_backlog"),
    (PLAN_LIST, "wm_plans_project"),
    (TASK_LIST, "wm_tasks_order"),
    (TASK_PROGRESS, "wm_tasks_progress"),
    (PENDING_INSTRUCTIONS, "wm_instructions_pending"),
    (RUNNING_ATTEMPTS, "wm_attempts_running"),
    (UNPUBLISHED_OUTBOX, "wm_outbox_unpublished"),
    (PENDING_INTENTS, "wm_cross_db_intents_pending"),
    (LEGACY_LOOKUP, "sqlite_autoindex_wm_legacy_map_1"),
    (SPEC_CHILDREN, "wm_spec_nodes_parent"),
    (SCOPED_WORKS, "wm_works_scope"),
    (CHAIN_EDGES, "wm_work_edges_chain"),
    (TASK_PREDECESSORS, "wm_task_edges_successor"),
    (CRITERION_CONSUMERS, "wm_task_criteria_consumers"),
    (WORK_SPEC_NODES, "wm_spec_nodes_work"),
    (TASK_LEASE, "wm_attempts_lease"),
];
