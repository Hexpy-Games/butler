//! Query plans of the hot statements. A partial index applies only to a query
//! that repeats its predicate, so a statement that loses that term silently
//! falls back to scanning a table that grows without bound.

use rusqlite::{Connection, params_from_iter, types::Value};

use super::{migrate, migration::SETTLE_ENDED_SQL};
use crate::gateway::application::{
    automations::queued_sql,
    monitoring::usage::SCHEDULE_SESSIONS_SQL,
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

/// Exercise the deployed-schema upgrade and production lookup at owner scale.
pub(super) fn schedule_window_uses_turn_indexes() {
    let mut db = Connection::open_in_memory().unwrap();
    migrate(&mut db, None).unwrap();
    db.execute_batch("DROP INDEX session_queued_messages_turn_idx;
        DROP INDEX automation_runs_turn_idx;
        CREATE INDEX automation_runs_pending_idx ON app_automation_runs(completed_at,turn_id,queued_message_id) WHERE completed_at IS NULL;
        CREATE INDEX automation_runs_completed_idx ON app_automation_runs(julianday(completed_at),turn_id,queued_message_id);
        INSERT INTO chats(id,title,kind,created_at,updated_at) VALUES('c','Chat','chat','old','old');
        INSERT INTO app_automations(id,title,prompt_body,target_kind,target_session_id,interval_seconds,state,last_run_state,created_at,updated_at)
            VALUES('a','Report','Report','chat','c',3600,'paused','delivered','old','old');
        WITH RECURSIVE n(i) AS (VALUES(0) UNION ALL SELECT i+1 FROM n WHERE i<299999)
        INSERT INTO session_queued_messages(id,chat_id,text,attachments_json,controls_json,state,turn_id,created_at,updated_at)
            SELECT 'q-'||i,'c','Report','[]','{}','dispatched','queued-'||i,'old','old' FROM n;
        WITH RECURSIVE n(i) AS (VALUES(0) UNION ALL SELECT i+1 FROM n WHERE i<299999)
        INSERT INTO app_automation_runs(id,automation_id,target_session_id,state,trigger,started_at,completed_at,turn_id,queued_message_id)
            SELECT 'r-'||i,'a','c','delivered','scheduled','2026-01-01','2026-01-01','direct-'||i,'q-'||i FROM n;")
        .unwrap();
    migrate(&mut db, None).unwrap();
    migrate(&mut db, None).unwrap();
    db.execute_batch("ANALYZE").unwrap();
    for table in ["app_automation_runs", "session_queued_messages"] {
        let count: i64 = db
            .query_row(&format!("SELECT COUNT(*) FROM {table}"), [], |r| r.get(0))
            .unwrap();
        assert_eq!(count, 300_000);
    }
    let retired: i64 = db.query_row("SELECT COUNT(*) FROM sqlite_master WHERE name IN ('automation_runs_pending_idx','automation_runs_completed_idx')", [], |r| r.get(0)).unwrap();
    assert_eq!(retired, 0);
    let plan = plan(&db, SCHEDULE_SESSIONS_SQL);
    eprintln!("schedule lookup: 300000 runs + 300000 queued messages\n{plan}");
    for search in [
        "SEARCH r USING COVERING INDEX automation_runs_turn_idx (turn_id=?)",
        "SEARCH q USING INDEX session_queued_messages_turn_idx (turn_id=?)",
        "SEARCH r USING COVERING INDEX automation_runs_message_idx (queued_message_id=?)",
    ] {
        assert!(plan.contains(search), "{plan}");
    }
    assert!(
        !plan.contains("SCAN r") && !plan.contains("SCAN q"),
        "{plan}"
    );
    assert_schedule_matches(&db);
}

fn assert_schedule_matches(db: &Connection) {
    let mut statement = db.prepare(SCHEDULE_SESSIONS_SQL).unwrap();
    let turns = serde_json::json!({
        "direct": ["direct-299999"], "queued": ["queued-299999"],
        "both": ["direct-0", "queued-1"],
        "mixed": ["direct-0", "interactive"], "chat": ["interactive"]
    })
    .to_string();
    let mut sessions = statement
        .query_map([turns], |r| r.get::<_, String>(0))
        .unwrap()
        .collect::<Result<Vec<_>, _>>()
        .unwrap();
    sessions.sort();
    assert_eq!(sessions, ["both", "direct", "queued"]);
}
