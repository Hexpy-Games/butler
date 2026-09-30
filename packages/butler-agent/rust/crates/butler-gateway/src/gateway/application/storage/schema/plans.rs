//! Query plans of the hot statements. A partial index applies only to a query
//! that repeats its predicate, so a statement that loses that term silently
//! falls back to scanning a table that grows without bound.

use rusqlite::{Connection, params_from_iter, types::Value};

use super::{migrate, migration::SETTLE_ENDED_SQL};
use crate::gateway::application::{
    automations::queued_sql,
    progress_view::LIVE_ROWS_SQL,
    projection::HAS_KIND_SQL,
    queue::RESTORE_CLAIM_SQL,
    queue_dispatcher::{LEASE_DEADLINE_SQL, QUEUED_CHATS_SQL},
    recovery::DISPATCHING_SQL,
    retry::RUNTIME_FAULT_SQL,
};

const EVENTS_INDEX: &str = "events_turn_id_idx";
const QUEUE_INDEX: &str = "session_queued_messages_active_idx";

/// The plan of `sql` with every parameter bound to NULL.
fn plan(connection: &Connection, sql: &str) -> String {
    let mut statement = connection
        .prepare(&format!("EXPLAIN QUERY PLAN {sql}"))
        .unwrap();
    let parameters = statement.parameter_count();
    statement
        .query_map(
            params_from_iter(std::iter::repeat_n(Value::Null, parameters)),
            |row| row.get::<_, String>(3),
        )
        .unwrap()
        .map(Result::unwrap)
        .collect::<Vec<_>>()
        .join("\n")
}

fn assert_uses(connection: &Connection, sql: &str, index: &str) {
    let plan = plan(connection, sql);
    assert!(plan.contains(index), "{sql}\nplan: {plan}");
}

pub(super) fn hot_queries_use_their_indexes() {
    let mut connection = Connection::open_in_memory().unwrap();
    migrate(&mut connection, None).unwrap();
    for sql in [
        HAS_KIND_SQL,
        RUNTIME_FAULT_SQL,
        LIVE_ROWS_SQL,
        RESTORE_CLAIM_SQL,
    ] {
        assert_uses(&connection, sql, EVENTS_INDEX);
    }
    // The control: without the `turn_id<>''` term the events table is scanned.
    let unpinned = HAS_KIND_SQL.replace(" AND turn_id<>''", "");
    assert!(!plan(&connection, &unpinned).contains(EVENTS_INDEX));

    for sql in [QUEUED_CHATS_SQL, LEASE_DEADLINE_SQL, DISPATCHING_SQL] {
        assert_uses(&connection, sql, QUEUE_INDEX);
    }
    assert_uses(&connection, &queued_sql(), "app_automation_runs_queued_idx");
    assert_uses(&connection, SETTLE_ENDED_SQL, "messages_streaming_turn_idx");
}
