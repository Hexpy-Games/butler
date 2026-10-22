#![allow(clippy::unwrap_used, reason = "test assertions")]
mod store_support;
use butler_work::{store::*, work_schema, work_types::*};
use rusqlite::{Connection, TransactionBehavior};
use std::{
    path::PathBuf,
    sync::{Arc, Barrier, mpsc},
    thread,
};
use store_support::*;
struct Database(PathBuf);
impl Database {
    fn new() -> Self {
        let result =
            Self(std::env::temp_dir().join(format!("work-{}.sqlite", uuid::Uuid::new_v4())));
        let db = result.open();
        work_schema::ensure(&db).unwrap();
        result
    }
    fn open(&self) -> Connection {
        connection(&self.0)
    }
}
impl Drop for Database {
    fn drop(&mut self) {
        let _ = std::fs::remove_file(&self.0);
        for suffix in ["-wal", "-shm"] {
            let _ = std::fs::remove_file(format!("{}{suffix}", self.0.display()));
        }
    }
}
fn connection(path: &std::path::Path) -> Connection {
    let db = Connection::open(path).unwrap();
    db.busy_timeout(std::time::Duration::from_secs(5)).unwrap();
    db.execute_batch("PRAGMA foreign_keys=ON").unwrap();
    db
}
fn race(
    db: &Database,
    operation: impl Fn(&rusqlite::Transaction<'_>, usize) -> Result<serde_json::Value>
    + Send
    + Sync
    + 'static,
) -> Vec<Result<serde_json::Value>> {
    let barrier = Arc::new(Barrier::new(2));
    let operation = Arc::new(operation);
    let handles: Vec<_> = (0..2)
        .map(|i| {
            let path = db.0.clone();
            let barrier = barrier.clone();
            let operation = operation.clone();
            thread::spawn(move || {
                let mut db = connection(&path);
                barrier.wait();
                let tx = db
                    .transaction_with_behavior(TransactionBehavior::Immediate)
                    .unwrap();
                let result = operation(&tx, i);
                if result.is_ok() {
                    tx.commit().unwrap();
                } else {
                    tx.rollback().unwrap();
                }
                result
            })
        })
        .collect();
    handles.into_iter().map(|h| h.join().unwrap()).collect()
}
// test-category: race
#[test]
fn concurrent_canon_edit_has_one_winner_and_returns_current_value() {
    let file = Database::new();
    let mut db = file.open();
    work(&mut db, "a");
    drop(db);
    let results = race(&file, |tx, i| {
        let mut fields = WorkFields::from_snapshot(&read_work(tx, "a")?).unwrap();
        fields.title = format!("title-{i}");
        edit_work(tx, &context(), "a", 0, &fields)
    });
    assert_eq!(results.iter().filter(|r| r.is_ok()).count(), 1);
    let winner = read_work(&file.open(), "a").unwrap();
    assert_eq!(winner["revision"], 1);
    let loser = results
        .into_iter()
        .find_map(std::result::Result::err)
        .unwrap();
    assert!(matches!(loser,Error::Conflict {current} if current==winner));
}
// test-category: race
#[test]
fn hold_final_admission_has_one_winner() {
    let file = Database::new();
    let mut db = file.open();
    queue(&mut db, &["a", "b", "c"]);
    runtime(&mut db, "a", TaskStatus::Failed, false);
    let row = undecided_holds(&db, "ch").unwrap().remove(0);
    let expected = graph(&db);
    drop(db);
    let id = row["id"].as_str().unwrap().to_owned();
    let results = race(&file, move |tx, i| {
        decide_hold(
            tx,
            &context(),
            &id,
            0,
            expected,
            if i == 0 {
                Decision::RunAnyway
            } else {
                Decision::Delete
            },
        )
    });
    assert_eq!(results.iter().filter(|r| r.is_ok()).count(), 1);
    assert!(results.into_iter().any(|r|matches!(r,Err(Error::Conflict {current}) if current==serde_json::json!({"revision":graph(&file.open())}))));
}
// test-category: race
#[test]
fn queue_edit_and_completion_serialize_in_both_orders_without_stale_edges() {
    for completion_first in [false, true] {
        let file = Database::new();
        let mut db = file.open();
        queue(&mut db, &["a", "b", "c"]);
        runtime(&mut db, "a", TaskStatus::Running, false);
        let graph_revision = graph(&db);

        let work_revision = revision(&db, "a");
        drop(db);
        let (committed_tx, committed_rx) = mpsc::channel();
        let path = file.0.clone();

        let first = thread::spawn(move || {
            let mut db = connection(&path);
            let tx = db
                .transaction_with_behavior(TransactionBehavior::Immediate)
                .unwrap();
            if completion_first {
                transition(
                    &tx,
                    &context(),
                    "a",
                    work_revision,
                    TaskStatus::Completed,
                    true,
                    None,
                )
                .unwrap();
            } else {
                edit_queue(
                    &tx,
                    &context(),
                    "work",
                    graph_revision,
                    &[QueueEdit::MoveToNewStep {
                        chain_id: "ch".into(),
                        task_id: "b".into(),
                        index: 2,
                    }],
                )
                .unwrap();
            }
            tx.commit().unwrap();
            committed_tx.send(()).unwrap();
        });
        let path = file.0.clone();
        let second = thread::spawn(move || {
            let mut db = connection(&path);
            committed_rx.recv().unwrap();
            let tx = db
                .transaction_with_behavior(TransactionBehavior::Immediate)
                .unwrap();
            if completion_first {
                edit_queue(
                    &tx,
                    &context(),
                    "work",
                    graph_revision,
                    &[QueueEdit::JoinStack {
                        chain_id: "ch".into(),
                        task_id: "b".into(),
                        target: "c".into(),
                    }],
                )
                .unwrap();
                tx.commit().unwrap();
            } else {
                assert_eq!(
                    load_chain(&tx, "ch").unwrap().chain.steps[1].tasks[0].as_str(),
                    "c"
                );
                transition(
                    &tx,
                    &context(),
                    "a",
                    work_revision,
                    TaskStatus::Completed,
                    true,
                    None,
                )
                .unwrap();
                tx.commit().unwrap();
            }
        });
        first.join().unwrap();
        second.join().unwrap();
        let db = file.open();
        let chain = load_chain(&db, "ch").unwrap();
        chain.chain.validate().unwrap();
        let mut edges = chain.chain.edges().unwrap();
        edges.sort();
        let stored = db
            .prepare("SELECT pred,succ FROM wm_task_edges WHERE chain_id=?1 ORDER BY pred,succ")
            .unwrap()
            .query_map(["ch"], |r| Ok((TaskId(r.get(0)?), TaskId(r.get(1)?))))
            .unwrap()
            .collect::<rusqlite::Result<Vec<_>>>()
            .unwrap();
        assert_eq!(edges, stored);
        assert_eq!(read_task(&db, "a").unwrap()["step_index"], 0);
    }
}
