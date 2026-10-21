#![allow(dead_code, clippy::unwrap_used, reason = "test helpers")]
use butler_work::{store::*, work_schema, work_types::*};
use rusqlite::{Connection, TransactionBehavior};
pub(crate) fn db() -> Connection {
    let db = Connection::open_in_memory().unwrap();
    db.execute_batch("PRAGMA foreign_keys=ON").unwrap();
    work_schema::ensure(&db).unwrap();
    db
}
pub(crate) fn context() -> Context {
    Context {
        now: 100,
        actor: serde_json::json!({"person":"tester"}),
    }
}
pub(crate) fn work(db: &mut Connection, id: &str) {
    let tx = db.transaction().unwrap();
    create_work(
        &tx,
        &context(),
        &NewWork {
            id: id.into(),
            scope_kind: ScopeKind::Session,
            scope_ref: "chat".into(),
            title: id.into(),
            description: String::new(),
            origin: Origin::Chat,
            draft: false,
        },
        &Registration::Canon(UserAct::new("tester")),
    )
    .unwrap();
    tx.commit().unwrap();
}
pub(crate) fn revision(db: &Connection, id: &str) -> i64 {
    read_work(db, id).unwrap()["revision"].as_i64().unwrap()
}
pub(crate) fn graph(db: &Connection, id: &str) -> i64 {
    db.query_row(
        "SELECT graph_revision FROM wm_work_chains WHERE id=?1",
        [id],
        |r| r.get(0),
    )
    .unwrap()
}
pub(crate) fn queue(db: &mut Connection, ids: &[&str]) {
    for id in ids {
        work(db, id);
    }
    let tx = db
        .transaction_with_behavior(TransactionBehavior::Immediate)
        .unwrap();
    create_root(
        &tx,
        &context(),
        ids[0],
        0,
        "ch",
        "chat",
        QueueOrigin::UserMessage,
        Some("message"),
    )
    .unwrap();
    tx.commit().unwrap();
    for pair in ids.windows(2) {
        let tx = db.transaction().unwrap();
        place_after(&tx, &context(), pair[1], 0, pair[0], graph(&tx, "ch")).unwrap();
        tx.commit().unwrap();
    }
}
pub(crate) fn runtime(db: &mut Connection, id: &str, state: RunState, reported: bool) {
    if matches!(
        state,
        RunState::Failed
            | RunState::Stopped
            | RunState::Paused
            | RunState::Blocked
            | RunState::InReview
            | RunState::Done
    ) && matches!(
        read_work(db, id).unwrap()["run_state"].as_str(),
        Some("idle" | "waiting")
    ) {
        runtime(db, id, RunState::Running, false);
    }
    let tx = db.transaction().unwrap();
    transition(
        &tx,
        &context(),
        id,
        revision(&tx, id),
        state,
        reported,
        Some("task_failed"),
    )
    .unwrap();
    tx.commit().unwrap();
}
pub(crate) fn member_revisions(db: &Connection, id: &str) -> Vec<(String, i64)> {
    load_chain(db, id)
        .unwrap()
        .members
        .iter()
        .map(|r| {
            (
                r["id"].as_str().unwrap().into(),
                r["revision"].as_i64().unwrap(),
            )
        })
        .collect()
}
