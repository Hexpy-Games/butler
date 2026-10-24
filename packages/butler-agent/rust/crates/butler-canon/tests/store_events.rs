#![allow(clippy::unwrap_used, reason = "test assertions")]
mod store_support;
use butler_canon::{store::*, work_types::*};
use serde_json::{Value, json};
use store_support::*;

fn events(db: &rusqlite::Connection) -> Vec<Value> {
    db.prepare("SELECT payload_json FROM wm_outbox WHERE topic='work_model.changed' ORDER BY seq")
        .unwrap()
        .query_map([], |r| r.get::<_, String>(0))
        .unwrap()
        .map(|r| serde_json::from_str(&r.unwrap()).unwrap())
        .collect()
}

// test-category: pure-logic
#[test]
fn runtime_review_emits_once_with_the_unchanged_structure_revision() {
    let mut db = db();
    queue(&mut db, &["a"]);
    db.execute(
        "UPDATE wm_works SET visibility='private',canon_status=NULL,canon_status_source=NULL",
        [],
    )
    .unwrap();
    let expected = graph(&db);
    let mut count = events(&db).len();
    for (state, reported) in [
        (TaskStatus::Running, false),
        (TaskStatus::InReview, false),
        (TaskStatus::Completed, false),
        (TaskStatus::Completed, true),
    ] {
        runtime(&mut db, "a", state, reported);
        let rows = events(&db);
        assert_eq!(rows.len(), count + 1);
        assert_eq!(
            rows.last().unwrap(),
            &json!({"scope":"tasks","work_id":"work",
            "session_id":"chat","task_graph_revision":expected})
        );
        assert_eq!(graph(&db), expected);
        count = rows.len();
    }
    runtime(&mut db, "a", TaskStatus::Completed, true);
    assert_eq!(events(&db).len(), count);
}

// test-category: pure-logic
#[test]
fn transaction_coalesces_progress_holds_and_structure_and_rolls_back() {
    let mut db = db();
    queue(&mut db, &["a", "b"]);
    work(&mut db, "other");
    let before = events(&db);
    for commit in [false, true] {
        let tx = Transaction::new(db.transaction().unwrap()).unwrap();
        for state in [
            TaskStatus::Running,
            TaskStatus::InReview,
            TaskStatus::Failed,
        ] {
            transition(
                &tx,
                &context(),
                "a",
                revision(&tx, "a"),
                state,
                false,
                Some("failed"),
            )
            .unwrap();
        }
        let rows = events(&tx);
        assert_eq!(rows.len(), before.len() + 1);
        assert_eq!(rows.last().unwrap()["task_graph_revision"], graph(&tx));
        assert_eq!(undecided_holds(&tx, "ch").unwrap().len(), 1);
        // A second Work gets its own row; rolling its savepoint back must
        // also discard that row before the same Work changes again.
        tx.execute_batch("SAVEPOINT other_work").unwrap();
        for rollback in [true, false] {
            let other = read_work(&tx, "other").unwrap();
            set_label(
                &tx,
                &context(),
                "other",
                other["revision"].as_i64().unwrap(),
                CanonStatus::Done,
                &UserAct::new("tester"),
                Some(0),
            )
            .unwrap();
            let rows = events(&tx);
            assert_eq!(rows.len(), before.len() + 2);
            assert_eq!(rows.last().unwrap()["work_id"], "other");
            assert_eq!(rows.last().unwrap()["task_graph_revision"], 1);
            if rollback {
                tx.execute_batch("ROLLBACK TO other_work; RELEASE other_work")
                    .unwrap();
                assert_eq!(events(&tx).len(), before.len() + 1);
            }
        }
        if commit {
            tx.commit().unwrap();
        } else {
            tx.rollback().unwrap();
            assert_eq!(events(&db), before);
        }
    }
}
