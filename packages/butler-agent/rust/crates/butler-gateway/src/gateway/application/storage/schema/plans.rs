//! Query plans of the hot statements. A partial index applies only to a query
//! that repeats its predicate, so a statement that loses that term silently
//! falls back to scanning a table that grows without bound.

use rusqlite::{Connection, params_from_iter, types::Value};

use super::{migrate, migration::SETTLE_ENDED_SQL};
use crate::gateway::application::{
    automations::queued_sql,
    monitoring::usage::SCHEDULE_TURN_SQL,
    progress_view::LIVE_ROWS_SQL,
    projection::HAS_KIND_SQL,
    queue::{CLAIM_SQL, RESTORE_CLAIM_SQL},
    queue_dispatcher::{LEASE_DEADLINE_SQL, QUEUED_CHATS_SQL, QUEUED_ROWS_SQL},
    recovery::DISPATCHING_SQL,
    retry::RUNTIME_FAULT_SQL,
    turn_cancellation::SENT_CANCELS_SQL,
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
    for sql in [super::work_model::RECEIPT, super::work_model::PRUNE] {
        assert_uses(&connection, sql, "INTEGER PRIMARY KEY");
    }
    let sidebar = super::canon_sidebar::ORDERED_READ;
    assert_uses(&connection, sidebar, "app_canon_sidebar_order_position");
    assert!(!plan(&connection, sidebar).contains("SCAN app_canon_sidebar_order"));
    assert!(
        !plan(
            &connection,
            "SELECT * FROM app_canon_sidebar_order WHERE work_id=?1"
        )
        .contains("app_canon_sidebar_order_position")
    );
    // The control: without the `turn_id<>''` term the events table is scanned.
    let unpinned = HAS_KIND_SQL.replace(" AND turn_id<>''", "");
    assert!(!plan(&connection, &unpinned).contains(EVENTS_INDEX));

    for sql in [QUEUED_CHATS_SQL, LEASE_DEADLINE_SQL, DISPATCHING_SQL] {
        assert_uses(&connection, sql, QUEUE_INDEX);
    }
    result_order_uses_index(&connection);
    assert_uses(&connection, &queued_sql(), "app_automation_runs_queued_idx");
    assert_uses(
        &connection,
        SENT_CANCELS_SQL,
        "app_turn_cancel_outbox_pending_idx",
    );
    assert_uses(&connection, SETTLE_ENDED_SQL, "messages_streaming_turn_idx");
}

/// Exercise the deployed-schema upgrade and production lookup with retained history.
pub(super) fn schedule_window_uses_turn_indexes() {
    let mut db = Connection::open_in_memory().unwrap();
    migrate(&mut db, None).unwrap();
    // The deployed schema: no turn indexes yet, and the superseded started-at index.
    db.execute_batch("DROP INDEX session_queued_messages_turn_idx;
        DROP INDEX automation_runs_turn_idx;
        CREATE INDEX automation_runs_started_idx
            ON app_automation_runs(julianday(started_at),turn_id,queued_message_id);
        INSERT INTO chats(id,title,kind,created_at,updated_at) VALUES('c','Chat','chat','old','old');
        INSERT INTO app_automations(id,title,prompt_body,target_kind,target_session_id,interval_seconds,state,last_run_state,created_at,updated_at)
            VALUES('a','Report','Report','chat','c',3600,'paused','delivered','old','old');
        WITH RECURSIVE n(i) AS (VALUES(0) UNION ALL SELECT i+1 FROM n WHERE i<47)
        INSERT INTO session_queued_messages(id,chat_id,text,attachments_json,controls_json,state,turn_id,created_at,updated_at)
            SELECT 'q-'||i,'c','Report','[]','{}','dispatched','queued-'||i,'old','old' FROM n;
        WITH RECURSIVE n(i) AS (VALUES(0) UNION ALL SELECT i+1 FROM n WHERE i<47)
        INSERT INTO app_automation_runs(id,automation_id,target_session_id,state,trigger,started_at,completed_at,turn_id,queued_message_id)
            SELECT 'r-'||i,'a','c','delivered','scheduled','2026-01-01','2026-01-01','direct-'||i,'q-'||i FROM n;")
        .unwrap();
    migrate(&mut db, None).unwrap();
    migrate(&mut db, None).unwrap();
    let started_idx: i64 = db
        .query_row(
            "SELECT COUNT(*) FROM sqlite_master WHERE type='index' AND name='automation_runs_started_idx'",
            [],
            |r| r.get(0),
        )
        .unwrap();
    assert_eq!(started_idx, 0, "migrate must drop the superseded index");
    db.execute_batch("ANALYZE").unwrap();
    for table in ["app_automation_runs", "session_queued_messages"] {
        let count: i64 = db
            .query_row(&format!("SELECT COUNT(*) FROM {table}"), [], |r| r.get(0))
            .unwrap();
        assert_eq!(count, 48);
    }
    let plan = plan(&db, SCHEDULE_TURN_SQL);
    eprintln!("schedule lookup: 48 runs + 48 queued messages\n{plan}");
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
    let mut statement = db.prepare(SCHEDULE_TURN_SQL).unwrap();
    for (turn, expected) in [
        ("direct-47", true),
        ("queued-47", true),
        ("direct-0", true),
        ("queued-1", true),
        ("interactive", false),
    ] {
        let actual: bool = statement.query_row([turn], |r| r.get(0)).unwrap();
        assert_eq!(actual, expected, "{turn}");
    }
}

/// Retained user rows cannot fill the dispatch window ahead of newer results.
fn result_order_uses_index(db: &Connection) {
    let claimed = plan(db, CLAIM_SQL);
    assert!(
        claimed.contains("session_queued_messages_result_order_idx"),
        "{claimed}"
    );
    assert!(!claimed.contains("TEMP B-TREE"), "{claimed}");
    let ordered = plan(db, QUEUED_ROWS_SQL);
    assert!(
        ordered.contains("session_queued_messages_result_order_idx"),
        "{ordered}"
    );
    assert!(!ordered.contains("TEMP B-TREE"), "{ordered}");
    db.execute_batch(r#"INSERT INTO chats(id,title,kind,created_at,updated_at) VALUES('parent','Parent','chat','now','now');
        WITH RECURSIVE n(i) AS (VALUES(0) UNION ALL SELECT i+1 FROM n WHERE i<24)
        INSERT INTO session_queued_messages(id,chat_id,text,attachments_json,controls_json,control_resolution_json,state,created_at,updated_at)
        SELECT 'user-'||i,'parent','Request','[]','{}','{}','queued','now','now' FROM n;
        INSERT INTO session_queued_messages(id,chat_id,text,attachments_json,controls_json,control_resolution_json,state,created_at,updated_at)
        VALUES('result-1','parent','Result','[]','{}','{"subsession_result":{}}','queued','now','now'),
              ('result-2','parent','Result','[]','{}','{"subsession_result":{}}','queued','now','now');"#)
        .unwrap();
    let rows = db
        .prepare(QUEUED_ROWS_SQL)
        .unwrap()
        .query_map(rusqlite::params!["parent", 20], |row| {
            row.get::<_, String>(0)
        })
        .unwrap()
        .collect::<Result<Vec<_>, _>>()
        .unwrap();
    let expected: Vec<_> = ["result-1".to_owned(), "result-2".to_owned()]
        .into_iter()
        .chain((0..18).map(|i| format!("user-{i}")))
        .collect();
    assert_eq!(rows, expected);
}
