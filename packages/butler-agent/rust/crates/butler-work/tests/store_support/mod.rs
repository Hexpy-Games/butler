#![allow(dead_code, clippy::unwrap_used, reason = "test helpers")]
use butler_work::{store::*, work_schema, work_types::*};
use rusqlite::Connection;
use serde_json::{Value, json};
pub(crate) fn db() -> Connection {
    let db = Connection::open_in_memory().unwrap();
    db.execute_batch("PRAGMA foreign_keys=ON").unwrap();
    work_schema::ensure(&db).unwrap();
    db
}
pub(crate) fn context() -> Context {
    Context {
        now: 100,
        actor: json!({"person":"tester"}),
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
    read_task(db, id).unwrap()["revision"].as_i64().unwrap()
}
pub(crate) fn graph(db: &Connection) -> i64 {
    read_work(db, "work").unwrap()["task_graph_revision"]
        .as_i64()
        .unwrap()
}
pub(crate) fn add(db: &mut Connection, id: &str, chain: &str, after: Option<&str>, draft: bool) {
    let tx = db.transaction().unwrap();
    create_task(
        &tx,
        &context(),
        &NewTask {
            id: id.into(),
            work_id: "work".into(),
            title: id.into(),
            spec_ref: json!({}),
            draft,
            origin: QueueOrigin::Planner,
            origin_message_id: None,
        },
        graph(&tx),
        chain,
        after,
    )
    .unwrap();
    tx.commit().unwrap();
}
pub(crate) fn queue(db: &mut Connection, ids: &[&str]) {
    work(db, "work");
    for (i, id) in ids.iter().enumerate() {
        add(db, id, "ch", i.checked_sub(1).map(|j| ids[j]), false);
    }
}
pub(crate) fn runtime(db: &mut Connection, id: &str, state: TaskStatus, reported: bool) {
    if matches!(
        state,
        TaskStatus::Failed
            | TaskStatus::Stopped
            | TaskStatus::Paused
            | TaskStatus::Blocked
            | TaskStatus::InReview
            | TaskStatus::Completed
    ) && matches!(
        read_task(db, id).unwrap()["status"].as_str(),
        Some("pending" | "waiting")
    ) {
        runtime(db, id, TaskStatus::Running, false);
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
pub(crate) fn edit(db: &mut Connection, ops: &[QueueEdit]) -> Result<Vec<Value>> {
    let tx = db.transaction().unwrap();
    let result = edit_queue(&tx, &context(), "work", graph(&tx), ops)?;
    tx.commit().unwrap();
    Ok(result)
}
pub(crate) fn decide(db: &mut Connection, decision: Decision) {
    let tx = db.transaction().unwrap();
    let q = undecided_holds(&tx, "ch").unwrap().remove(0);
    decide_hold(
        &tx,
        &context(),
        q["id"].as_str().unwrap(),
        q["revision"].as_i64().unwrap(),
        graph(&tx),
        decision,
    )
    .unwrap();
    tx.commit().unwrap();
}
pub(crate) fn approved_failure() -> Connection {
    let mut db = db();
    queue(&mut db, &["a", "b", "c"]);
    runtime(&mut db, "a", TaskStatus::Failed, false);
    decide(&mut db, Decision::RunAnyway);
    assert_eq!(ready_tasks(&db, "ch").unwrap(), vec!["b"]);
    runtime(&mut db, "b", TaskStatus::Running, false);
    db
}
