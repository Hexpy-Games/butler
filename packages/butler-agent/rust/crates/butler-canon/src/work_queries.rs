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
    ConversationWork => ("SELECT e.* FROM canon_session_epics s JOIN canon_epics e ON e.id=s.epic_id WHERE s.session_id=?1 ORDER BY s.bound_at,s.rowid", "canon_session_epics_session"),
    PlanOverview => ("SELECT * FROM canon_epics WHERE plan_id=?1 ORDER BY plan_rank", "canon_epics_plan"),
    Backlog => ("SELECT * FROM canon_epics WHERE project_id=?1 AND plan_id IS NULL ORDER BY plan_rank", "canon_epics_backlog"),
    PlanList => ("SELECT * FROM canon_plans WHERE project_id=?1 AND status=?2 ORDER BY due_on", "canon_plans_project"),
    UnpublishedOutbox => ("SELECT * FROM canon_events WHERE published=0 AND seq>?1 ORDER BY seq LIMIT ?2", "canon_events_unpublished"),
    PendingIntents => ("SELECT * FROM canon_intents WHERE state='pending' AND op_id>?1 ORDER BY op_id LIMIT ?2", "canon_intents_pending"),
    SpecChildren => ("SELECT * FROM canon_spec_nodes WHERE parent_node_id=?1", "canon_spec_nodes_parent"),
    WorkSpecNodes => ("SELECT * FROM canon_spec_nodes WHERE epic_id=?1", "canon_spec_nodes_epic"),
}
