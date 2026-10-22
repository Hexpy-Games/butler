#![allow(clippy::unwrap_used, reason = "test assertions")]
mod store_support;
use butler_work::{store::*, work_types::*};
use serde_json::json;
use store_support::*;

fn sibling(db: &mut rusqlite::Connection) {
    add(db, "s", "ch", Some("a"), false);
    edit(
        db,
        &[QueueEdit::JoinStack {
            chain_id: "ch".into(),
            task_id: "s".into(),
            target: "a".into(),
        }],
    )
    .unwrap();
}
fn chain_state(db: &rusqlite::Connection) -> String {
    db.query_row("SELECT state FROM wm_task_chains WHERE id='ch'", [], |r| {
        r.get(0)
    })
    .unwrap()
}

// test-category: pure-logic
#[test]
fn terminal_tasks_cannot_be_deleted_or_detached_and_keep_their_report() {
    let mut db = db();
    queue(&mut db, &["a", "b"]);
    runtime(&mut db, "a", TaskStatus::Completed, true);
    let before = read_task(&db, "a").unwrap();
    let rev = graph(&db);
    for op in [
        QueueEdit::Delete {
            chain_id: "ch".into(),
            task_id: "a".into(),
        },
        QueueEdit::Detach {
            chain_id: "ch".into(),
            task_id: "a".into(),
            new_chain_id: "new".into(),
        },
    ] {
        assert!(matches!(edit(&mut db, &[op]), Err(Error::Invalid(_))));
        assert_eq!(read_task(&db, "a").unwrap(), before);
        assert_eq!(graph(&db), rev);
    }
    runtime(&mut db, "b", TaskStatus::Cancelled, false);
    let cancelled = read_task(&db, "b").unwrap();
    assert!(cancelled["chain_id"].is_null());
    assert!(
        edit(
            &mut db,
            &[QueueEdit::Delete {
                chain_id: "ch".into(),
                task_id: "b".into()
            }]
        )
        .is_err()
    );
    assert!(matches!(
        edit(
            &mut db,
            &[QueueEdit::Detach {
                chain_id: "ch".into(),
                task_id: "b".into(),
                new_chain_id: "cancelled-head".into(),
            }]
        ),
        Err(Error::Invalid(_))
    ));
    assert_eq!(read_task(&db, "b").unwrap(), cancelled);
}

// test-category: race
#[test]
fn runtime_review_preserves_a_concurrent_structure_token_but_holds_advance_it() {
    let mut db = db();
    queue(&mut db, &["a", "b", "c"]);
    runtime(&mut db, "a", TaskStatus::Running, false);
    let expected = graph(&db);
    runtime(&mut db, "a", TaskStatus::InReview, false);
    assert_eq!(graph(&db), expected);
    let tx = db.transaction().unwrap();
    edit_queue(
        &tx,
        &context(),
        "work",
        expected,
        &[QueueEdit::JoinStack {
            chain_id: "ch".into(),
            task_id: "c".into(),
            target: "b".into(),
        }],
    )
    .unwrap();
    tx.commit().unwrap();
    let before = graph(&db);
    runtime(&mut db, "a", TaskStatus::Failed, false);
    assert_eq!(graph(&db), before + 1);
    assert_eq!(undecided_holds(&db, "ch").unwrap().len(), 1);
}

// test-category: pure-logic
#[test]
fn terminal_works_reject_task_admission() {
    for label in [CanonStatus::Done, CanonStatus::Cancelled] {
        let mut db = db();
        queue(&mut db, &["a"]);
        let tx = db.transaction().unwrap();
        set_label(
            &tx,
            &context(),
            "work",
            read_work(&tx, "work").unwrap()["revision"]
                .as_i64()
                .unwrap(),
            label,
            &UserAct::new("tester"),
            Some(graph(&tx)),
        )
        .unwrap();
        assert!(matches!(
            create_task(
                &tx,
                &context(),
                &NewTask {
                    id: "new".into(),
                    work_id: "work".into(),
                    title: "new".into(),
                    spec_ref: json!({}),
                    draft: false,
                    origin: QueueOrigin::Planner,
                    origin_message_id: None,
                },
                graph(&tx),
                "new",
                None
            ),
            Err(Error::Invalid(_))
        ));
        assert!(matches!(read_task(&tx, "new"), Err(Error::NotFound)));
    }
}

// test-category: pure-logic
#[test]
fn run_anyway_covers_only_failures_recorded_at_approval() {
    let mut db = db();
    queue(&mut db, &["a", "b"]);
    sibling(&mut db);
    runtime(&mut db, "s", TaskStatus::Running, false);
    runtime(&mut db, "a", TaskStatus::Failed, false);
    let first = undecided_holds(&db, "ch").unwrap().remove(0);
    decide(&mut db, Decision::RunAnyway);
    assert_eq!(read_task(&db, "b").unwrap()["status"], "waiting");
    runtime(&mut db, "s", TaskStatus::Failed, false);
    let next = undecided_holds(&db, "ch").unwrap();
    assert_eq!(next.len(), 1);
    assert_ne!(next[0]["id"], first["id"]);
    assert_eq!(next[0]["failed_task_id"], "s");
    assert_eq!(read_task(&db, "b").unwrap()["status"], "held");
    assert_eq!(ready_tasks(&db, "ch").unwrap(), Vec::<String>::new());
}

// test-category: pure-logic
#[test]
fn holds_skip_started_and_completed_followers_and_question_targets_first_held_step() {
    for completed in [false, true] {
        let mut db = approved_failure();
        if completed {
            runtime(&mut db, "b", TaskStatus::Completed, true);
        }
        let before = read_task(&db, "b").unwrap();
        runtime(&mut db, "a", TaskStatus::Running, false);
        runtime(&mut db, "a", TaskStatus::Failed, false);
        assert_eq!(read_task(&db, "b").unwrap(), before);
        let questions = undecided_holds(&db, "ch").unwrap();
        assert_eq!(questions.len(), 1);
        assert_eq!(questions[0]["held_step_index"], 2);
        assert_eq!(read_task(&db, "c").unwrap()["status"], "held");
    }
}

// test-category: pure-logic
#[test]
fn mutation_receipts_include_durable_questions_and_waiting_cannot_complete() {
    let mut db = db();
    queue(&mut db, &["a", "b"]);
    let tx = db.transaction().unwrap();
    assert!(matches!(
        transition(
            &tx,
            &context(),
            "b",
            revision(&tx, "b"),
            TaskStatus::Completed,
            true,
            None
        ),
        Err(Error::Invalid(_))
    ));
    tx.rollback().unwrap();
    runtime(&mut db, "a", TaskStatus::Running, false);
    let tx = db.transaction().unwrap();
    let receipt = transition(
        &tx,
        &context(),
        "a",
        revision(&tx, "a"),
        TaskStatus::Failed,
        false,
        Some("failed"),
    )
    .unwrap();
    let questions = undecided_holds(&tx, "ch").unwrap();
    assert_eq!(questions.len(), 1);
    assert_eq!(receipt["hold_questions"], json!(questions));
    tx.commit().unwrap();
    add(&mut db, "c", "other", None, false);
    let questions = edit(
        &mut db,
        &[QueueEdit::MoveBetween {
            chain_id: "other".into(),
            target_chain_id: "ch".into(),
            task_id: "c".into(),
            placement: butler_work::work_chain::Placement::NewStep(2),
        }],
    )
    .unwrap();
    assert_eq!(questions, undecided_holds(&db, "ch").unwrap());
}

// test-category: pure-logic
#[test]
fn runtime_transitions_map_canon_labels() {
    let mut db = db();
    queue(&mut db, &["a"]);
    for (state, label) in [
        (TaskStatus::Running, "in_progress"),
        (TaskStatus::Failed, "blocked"),
        (TaskStatus::Running, "in_progress"),
        (TaskStatus::Stopped, "blocked"),
    ] {
        runtime(&mut db, "a", state, false);
        let work = read_work(&db, "work").unwrap();
        assert_eq!(work["canon_status"], label);
        assert_eq!(work["canon_status_source"], "runtime");
    }
}

// test-category: pure-logic
#[test]
fn cancelling_the_only_failure_releases_followers_and_resolves_question() {
    let mut db = db();
    queue(&mut db, &["a", "b", "c"]);
    runtime(&mut db, "a", TaskStatus::Failed, false);
    let question = undecided_holds(&db, "ch").unwrap().remove(0);
    let before = graph(&db);
    runtime(&mut db, "a", TaskStatus::Cancelled, false);
    assert_eq!(graph(&db), before + 1);
    assert_eq!(
        undecided_holds(&db, "ch").unwrap(),
        Vec::<serde_json::Value>::new()
    );
    assert_eq!(ready_tasks(&db, "ch").unwrap(), vec!["b"]);
    assert_eq!(read_task(&db, "c").unwrap()["status"], "waiting");
    assert_eq!(chain_state(&db), "active");
    assert_eq!(
        db.query_row::<i64, _, _>(
            "SELECT resolved_at FROM wm_task_hold_decisions WHERE id=?1",
            [question["id"].as_str().unwrap()],
            |r| r.get(0)
        )
        .unwrap(),
        context().now
    );
}

// test-category: pure-logic
#[test]
fn counts_initialize_from_indexed_rows_then_update_by_delta() {
    let mut db = db();
    queue(&mut db, &["a"]);
    work(&mut db, "other");
    db.execute("DELETE FROM wm_counts", []).unwrap();
    let plan: String = db.query_row("EXPLAIN QUERY PLAN SELECT run_state,count(*) FROM wm_works WHERE scope_kind='session' AND scope_ref='chat' GROUP BY run_state", [], |r| r.get(3)).unwrap();
    assert!(
        plan.contains("SEARCH wm_works USING") && plan.contains("wm_works_scope"),
        "{plan}"
    );
    runtime(&mut db, "a", TaskStatus::Running, false);
    let counts = || {
        db.prepare("SELECT key,count FROM wm_counts ORDER BY key")
            .unwrap()
            .query_map([], |r| Ok((r.get::<_, String>(0)?, r.get::<_, i64>(1)?)))
            .unwrap()
            .collect::<rusqlite::Result<Vec<_>>>()
            .unwrap()
    };
    assert_eq!(
        counts(),
        vec![
            ("run_state:idle".into(), 1),
            ("run_state:running".into(), 1),
            ("works".into(), 2)
        ]
    );
    // A trigger proves subsequent transitions use deltas instead of deleting/rebuilding counters.
    db.execute_batch("CREATE TEMP TRIGGER counts_no_delete BEFORE DELETE ON wm_counts BEGIN SELECT RAISE(ABORT,'counter rebuild'); END;").unwrap();
    runtime(&mut db, "a", TaskStatus::InReview, false);
    assert_eq!(
        db.query_row::<i64, _, _>("SELECT count FROM wm_counts WHERE key='works'", [], |r| r
            .get(0))
            .unwrap(),
        2
    );
    assert_eq!(
        db.query_row::<i64, _, _>(
            "SELECT count FROM wm_counts WHERE key='run_state:in_review'",
            [],
            |r| r.get(0)
        )
        .unwrap(),
        1
    );
}

fn snapshot(db: &rusqlite::Connection) -> Vec<Vec<Vec<rusqlite::types::Value>>> {
    [
        "wm_tasks",
        "wm_task_chains",
        "wm_task_edges",
        "wm_task_hold_decisions",
        "wm_audit",
        "wm_outbox",
        "wm_counts",
        "wm_works",
    ]
    .into_iter()
    .map(|table| {
        let mut stmt = db
            .prepare(&format!("SELECT * FROM {table} ORDER BY 1,2"))
            .unwrap();
        let width = stmt.column_count();
        stmt.query_map([], |r| {
            (0..width)
                .map(|i| r.get(i))
                .collect::<rusqlite::Result<Vec<_>>>()
        })
        .unwrap()
        .collect::<rusqlite::Result<Vec<_>>>()
        .unwrap()
    })
    .collect()
}

// test-category: pure-logic
#[test]
fn failed_batch_rolls_back_edges_events_and_counts_even_if_outer_transaction_commits() {
    let mut db = db();
    queue(&mut db, &["a", "b", "c"]);
    runtime(&mut db, "a", TaskStatus::Failed, false);
    let before = snapshot(&db);
    // Reject the final graph event after membership, holds, edges and counts have changed.
    db.execute_batch("CREATE TEMP TRIGGER reject_graph BEFORE INSERT ON wm_audit WHEN NEW.entity_kind='task_graph' BEGIN SELECT RAISE(ABORT,'reject graph'); END;").unwrap();
    let tx = db.transaction().unwrap();
    assert!(
        edit_queue(
            &tx,
            &context(),
            "work",
            graph(&tx),
            &[QueueEdit::Delete {
                chain_id: "ch".into(),
                task_id: "a".into(),
            }]
        )
        .is_err()
    );
    tx.commit().unwrap();
    assert_eq!(snapshot(&db), before);
}

// test-category: pure-logic
#[test]
fn chain_state_is_held_only_with_a_question_and_done_only_when_all_report() {
    let mut db = db();
    queue(&mut db, &["a", "b"]);
    runtime(&mut db, "a", TaskStatus::Failed, false);
    assert_eq!(chain_state(&db), "held");
    decide(&mut db, Decision::RunAnyway);
    assert_eq!(chain_state(&db), "active");
    let before = graph(&db);
    runtime(&mut db, "b", TaskStatus::Failed, false);
    assert_eq!(graph(&db), before);
    assert_eq!(
        undecided_holds(&db, "ch").unwrap(),
        Vec::<serde_json::Value>::new()
    );
    assert_eq!(chain_state(&db), "active");
    runtime(&mut db, "a", TaskStatus::Running, false);
    runtime(&mut db, "a", TaskStatus::Completed, true);
    runtime(&mut db, "b", TaskStatus::Running, false);
    runtime(&mut db, "b", TaskStatus::Completed, false);
    assert_eq!(chain_state(&db), "active");
    runtime(&mut db, "b", TaskStatus::Completed, true);
    assert_eq!(chain_state(&db), "done");
}

// test-category: pure-logic
#[test]
fn deciding_an_already_decided_question_returns_only_the_structure_revision() {
    let mut db = db();
    queue(&mut db, &["a", "b"]);
    runtime(&mut db, "a", TaskStatus::Failed, false);
    let question = undecided_holds(&db, "ch").unwrap().remove(0);
    decide(&mut db, Decision::RunAnyway);
    let tx = db.transaction().unwrap();
    for revision in [0, 1] {
        let result = decide_hold(
            &tx,
            &context(),
            question["id"].as_str().unwrap(),
            revision,
            graph(&tx),
            Decision::RunAnyway,
        );
        assert!(
            matches!(result, Err(Error::Conflict { current }) if current == json!({"revision":graph(&tx)}))
        );
    }
}
