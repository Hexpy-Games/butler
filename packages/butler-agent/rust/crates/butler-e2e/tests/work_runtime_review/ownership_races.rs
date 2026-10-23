#![allow(clippy::unwrap_used, reason = "test assertions")]
#[path = "../../../butler-work/tests/store_support/mod.rs"]
mod store_support;
use butler_work::{store::*, work_schema, work_types::*};
use rusqlite::{Connection, TransactionBehavior};
use std::{
    path::PathBuf,
    sync::{Arc, Barrier},
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
    operation: impl Fn(&Transaction<'_>, usize) -> Result<serde_json::Value> + Send + Sync + 'static,
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
                let tx = Transaction::new(
                    db.transaction_with_behavior(TransactionBehavior::Immediate)
                        .unwrap(),
                )
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
fn two_sessions_take_one_reserved_task_once() -> std::result::Result<(), super::Failure> {
    butler_e2e::gate!();
    let file = Database::new();
    let mut db = file.open();
    queue(&mut db, &["task"]);
    let expected = revision(&db, "task");
    drop(db);
    let results = race(&file, move |tx, i| {
        ownership::take_here(tx, &context(), "task", &format!("session-{i}"), expected)
    });
    assert_eq!(results.iter().filter(|r| r.is_ok()).count(), 1);
    assert!(
        results
            .iter()
            .any(|r| matches!(r, Err(Error::Conflict { .. })))
    );
    assert_eq!(read_task(&file.open(), "task").unwrap()["owner_epoch"], 1);
    Ok(())
}

// test-category: race
#[test]
fn a_handoff_fences_late_effects_and_keeps_followers_ready()
-> std::result::Result<(), super::Failure> {
    butler_e2e::gate!();
    let mut db = db();
    queue(&mut db, &["a", "b"]);
    runtime(&mut db, "a", TaskStatus::Running, false);
    let tx = Transaction::new(db.transaction().unwrap()).unwrap();
    tiers::admit(&tx, &context(), "session", "work", 1, "task_session").unwrap();
    tx.execute("INSERT INTO wm_attempts(id,task_id,task_revision,spec_ref,session_id,lease_epoch,owner_epoch,status,started_at) VALUES('old','a',0,'{}','session',0,1,'running',1)",[]).unwrap();
    let before = read_task(&tx, "a").unwrap();
    ownership::take_here(&tx, &context(), "a", "new", revision(&tx, "a")).unwrap();
    assert_ne!(read_task(&tx, "b").unwrap()["status"], "held");
    let checkpoint = put_body(&tx, "finished step one; step two remains").unwrap();
    tx.execute(
        "UPDATE wm_attempts SET checkpoint_ref=?1 WHERE id='old'",
        [&checkpoint],
    )
    .unwrap();
    recover_session(&tx, &context(), "session", PreviousShutdown::Crash).unwrap();
    let moved = read_task(&tx, "a").unwrap();
    assert_eq!(
        moved["owner_epoch"].as_i64(),
        before["owner_epoch"].as_i64().map(|n| n + 1)
    );
    assert_eq!(moved["assignee_session_id"], "new");
    assert!(matches!(
        execution::ensure_task_effect(&tx, "a", "session"),
        Err(Error::Invalid("stale_owner"))
    ));
    let refs = vec!["late evidence".to_owned()];
    assert!(matches!(
        execution::submit_task(
            &tx,
            &context(),
            "a",
            &ExecutionScope {
                session_id: "session",
                turn_id: "old-turn",
            },
            &execution::Submission {
                part_id: None,
                result_id: "late-result",
                result_refs: &refs,
                evidence_refs: &refs,
            }
        ),
        Err(Error::Invalid("stale_owner"))
    ));
    assert_eq!(
        tx.query_row(
            "SELECT count(*) FROM wm_results WHERE id='late-result'",
            [],
            |r| r.get::<_, i64>(0)
        )
        .unwrap(),
        0
    );
    assert_eq!(read_task(&tx, "a").unwrap(), moved);
    assert_ne!(read_task(&tx, "b").unwrap()["status"], "held");
    assert_eq!(
        undecided_holds(&tx, "ch").unwrap(),
        Vec::<serde_json::Value>::new()
    );
    Ok(())
}

// test-category: race
#[test]
fn completion_and_handoff_have_exactly_one_winner() -> std::result::Result<(), super::Failure> {
    butler_e2e::gate!();
    use butler_work::store::execution::*;
    use serde_json::json;
    let file = Database::new();
    let mut db = file.open();
    let tx = Transaction::new(db.transaction().unwrap()).unwrap();
    tx.execute("INSERT INTO wm_instructions(id,idempotency_key,target_session_id,sender,mode,body_ref,anchor_kind,anchor_id,boundary_seq,status,received_seq) VALUES('request','request','owner','{}','queue','','turn','turn',0,'applied',0)",[]).unwrap();
    let scope = apply::ApplyScope {
        session_id: "owner".into(),
        turn_id: "turn".into(),
        instruction_id: "request".into(),
        work_id: None,
        tier: 1,
        planning: false,
        floors: Default::default(),
        child_session: false,
    };
    let input=serde_json::from_value(json!({"reason":"Prepare the requested artifact","operations":[
        {"op":"work.create_light","run_here":true,"goal":"Prepare artifact","done_criteria":["Created","Checked"],"tasks":[[{"key":"t","title":"Artifact","description":"Create and check"}]]},
        {"op":"task.start","task_id":"@t"}
    ]})).unwrap();
    let started = apply::apply(&tx, &context(), &scope, &input).unwrap();
    let task = started["keys"]["t"].as_str().unwrap().to_owned();
    let refs = vec!["artifact checked".to_owned()];
    submit_task(
        &tx,
        &context(),
        &task,
        &ExecutionScope {
            session_id: "owner",
            turn_id: "turn",
        },
        &Submission {
            part_id: None,
            result_id: "result",
            result_refs: &refs,
            evidence_refs: &refs,
        },
    )
    .unwrap();
    let judgments = tx
        .prepare(execution_sql::CRITERIA)
        .unwrap()
        .query_map([&task], |r| {
            Ok(CriterionResult {
                criterion_ref: CriterionRef {
                    node_id: r.get(0)?,
                    node_revision: r.get(1)?,
                    criterion_id: r.get(2)?,
                },
                met: true,
                evidence_refs: refs.clone(),
                note: "Verified".into(),
            })
        })
        .unwrap()
        .collect::<rusqlite::Result<Vec<_>>>()
        .unwrap();
    review_task(
        &tx,
        &context(),
        &task,
        "owner",
        &ReviewInput {
            result_revision: 1,
            review_id: "review",
            accept: true,
            judgments: &judgments,
        },
    )
    .unwrap();
    let expected = revision(&tx, &task);
    tx.commit().unwrap();
    drop(db);
    let race_task = task.clone();
    let results = race(&file, move |tx, i| {
        if i == 0 {
            complete_task(tx, &context(), &race_task, "owner", "review", true)
        } else {
            ownership::take_here(tx, &context(), &race_task, "next", expected)
        }
    });
    assert_eq!(
        results.iter().filter(|r| r.is_ok()).count(),
        1,
        "{results:?}"
    );
    let row = read_task(&file.open(), &task).unwrap();
    assert!(
        row["status"] == "completed" || row["handoff_to_session_id"] == "next",
        "{row}"
    );
    assert!(!(row["status"] == "completed" && row["handoff_to_session_id"] == "next"));
    Ok(())
}
