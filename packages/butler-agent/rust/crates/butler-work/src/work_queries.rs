//! Request-path statements and their required indexes share one declaration.
//! Every public statement is included in `Query::all()` for query-plan pins.
macro_rules! indexed_reads {
    ($($name:ident => ($sql:literal, $index:literal)),+ $(,)?) => {
        #[derive(Debug, Clone, Copy, PartialEq, Eq)]
        pub enum Query { $($name),+ }
        impl Query {
            pub const fn all() -> &'static [Self] { &[$(Self::$name),+] }
            pub const fn sql(self) -> &'static str {
                match self { $(Self::$name => $sql),+ }
            }
            pub const fn index(self) -> &'static str {
                match self { $(Self::$name => $index),+ }
            }
        }
    };
}

indexed_reads! {
    TaskChains => ("SELECT id,state,created_at FROM wm_task_chains
 WHERE work_id=?1 AND state=?2 ORDER BY created_at,id", "wm_task_chains_queue"),
    ChainMembers => ("SELECT id,step_index,stack_position,status,result_reported_at
 FROM wm_tasks WHERE chain_id=?1 ORDER BY step_index,stack_position", "wm_tasks_chain"),
    Readiness => ("SELECT pred FROM wm_task_edges WHERE work_id=?1 AND succ=?2", "wm_task_edges_successor"),
    HoldDecisions => ("SELECT * FROM wm_task_hold_decisions WHERE chain_id=?1 AND decision IS NULL AND resolved_at IS NULL", "wm_task_hold_decisions_pending"),
    ConversationWork => ("SELECT * FROM wm_works WHERE home_session_id=?1
 AND visibility='canon' AND home_session_id IS NOT NULL", "wm_works_home"),
    PlanOverview => ("SELECT * FROM wm_works WHERE plan_id=?1 AND visibility='canon' ORDER BY plan_rank", "wm_works_plan"),
    Backlog => ("SELECT * FROM wm_works WHERE scope_ref=?1 AND scope_kind='project' AND visibility='canon'
 AND plan_id IS NULL ORDER BY plan_rank", "wm_works_backlog"),
    PlanList => ("SELECT * FROM wm_plans WHERE project_id=?1 AND status=?2 ORDER BY due_on", "wm_plans_project"),
    TaskList => ("SELECT * FROM wm_tasks WHERE work_id=?1 ORDER BY chain_id,step_index,stack_position", "wm_tasks_progress"),
    TaskProgress => ("SELECT status,count(*) FROM wm_tasks WHERE work_id=?1 GROUP BY status", "wm_tasks_progress"),
    PendingInstructions => ("SELECT * FROM wm_instructions WHERE target_session_id=?1
 AND status IN ('accepted','waiting_for_turn','waiting_for_task','pending_safe_point') ORDER BY received_seq", "wm_instructions_pending"),
    RunningAttempts => ("SELECT * FROM wm_attempts WHERE session_id=?1 AND status='running'", "wm_attempts_running"),
    UnpublishedOutbox => ("SELECT * FROM wm_outbox WHERE published=0 AND seq>?1 ORDER BY seq LIMIT ?2", "wm_outbox_unpublished"),
    PendingIntents => ("SELECT * FROM wm_cross_db_intents WHERE state='pending' AND op_id>?1 ORDER BY op_id LIMIT ?2", "wm_cross_db_intents_pending"),
    LegacyLookup => ("SELECT new_id,source_hash,imported_revision,batch FROM wm_legacy_map WHERE source=?1 AND source_id=?2", "sqlite_autoindex_wm_legacy_map_1"),
    SpecChildren => ("SELECT * FROM wm_spec_nodes WHERE parent_node_id=?1", "wm_spec_nodes_parent"),
    ScopedWorks => ("SELECT * FROM wm_works WHERE scope_kind=?1 AND scope_ref=?2 AND visibility=?3 AND run_state=?4", "wm_works_scope"),
    ChainEdges => ("SELECT pred,succ FROM wm_task_edges WHERE chain_id=?1 ORDER BY pred,succ", "wm_task_edges_chain"),
    TaskPredecessors => ("SELECT pred FROM wm_task_edges WHERE work_id=?1 AND succ=?2", "wm_task_edges_successor"),
    CriterionConsumers => ("SELECT task_id FROM wm_task_criteria WHERE node_id=?1 AND node_revision=?2 AND criterion_id=?3", "wm_task_criteria_consumers"),
    WorkSpecNodes => ("SELECT * FROM wm_spec_nodes WHERE work_id=?1", "wm_spec_nodes_work"),
    TaskLease => ("SELECT * FROM wm_attempts WHERE task_id=?1 AND status='running'", "wm_attempts_lease"),
}
