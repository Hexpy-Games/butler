#![allow(clippy::unwrap_used, reason = "test assertions")]
mod store_support;
use butler_canon::{store::*, work_types::*};
use store_support::*;
// test-category: pure-logic
#[test]
fn holds_share_a_question_keep_siblings_and_release_only_one_barrier() {
    let mut db = db();
    queue(&mut db, &["a", "b", "c"]);
    add(&mut db, "s", "ch", Some("a"), false);
    edit(
        &mut db,
        &[QueueEdit::JoinStack {
            chain_id: "ch".into(),
            task_id: "s".into(),
            target: "a".into(),
        }],
    )
    .unwrap();
    runtime(&mut db, "s", TaskStatus::Running, false);
    runtime(&mut db, "a", TaskStatus::Failed, false);
    assert_eq!(read_task(&db, "s").unwrap()["status"], "running");
    assert_eq!(read_work(&db, "work").unwrap()["run_state"], "running");
    runtime(&mut db, "s", TaskStatus::Failed, false);
    assert_eq!(undecided_holds(&db, "ch").unwrap().len(), 1);
    for state in [
        TaskStatus::Running,
        TaskStatus::Pending,
        TaskStatus::Waiting,
    ] {
        let tx = Transaction::new(db.transaction().unwrap()).unwrap();
        assert!(transition(&tx, &context(), "b", revision(&tx, "b"), state, false, None).is_err());
    }
    decide(&mut db, Decision::RunAnyway);
    assert_eq!(ready_tasks(&db, "ch").unwrap(), vec!["b"]);
    runtime(&mut db, "b", TaskStatus::Running, false);
    assert_eq!(ready_tasks(&db, "ch").unwrap(), Vec::<String>::new());
    runtime(&mut db, "b", TaskStatus::Failed, false);
    let q = undecided_holds(&db, "ch").unwrap().remove(0);
    assert_eq!(q["failed_task_id"], "b");
    assert_eq!(q["held_step_index"], 2);
    decide(&mut db, Decision::Delete);
    assert_eq!(read_task(&db, "c").unwrap()["status"], "cancelled");
}
// test-category: pure-logic
#[test]
fn approvals_retire_on_failure_or_membership_change_and_repoint_questions() {
    for move_step in [false, true] {
        let mut db = approved_failure();
        if move_step {
            runtime(&mut db, "b", TaskStatus::Completed, true);
            edit(
                &mut db,
                &[QueueEdit::MoveToNewStep {
                    chain_id: "ch".into(),
                    task_id: "a".into(),
                    index: 1,
                }],
            )
            .unwrap();
        } else {
            runtime(&mut db, "a", TaskStatus::Running, false);
            runtime(&mut db, "a", TaskStatus::Failed, false);
        }
        let q = undecided_holds(&db, "ch").unwrap();
        assert_eq!(q.len(), 1);
        assert_eq!(read_task(&db, "c").unwrap()["held_by_task_id"], "a");
    }
    let mut db = db();
    queue(&mut db, &["a", "b"]);
    add(&mut db, "s", "ch", Some("a"), false);
    edit(
        &mut db,
        &[QueueEdit::JoinStack {
            chain_id: "ch".into(),
            task_id: "s".into(),
            target: "a".into(),
        }],
    )
    .unwrap();
    runtime(&mut db, "a", TaskStatus::Failed, false);
    runtime(&mut db, "s", TaskStatus::Failed, false);
    let before = undecided_holds(&db, "ch").unwrap().remove(0);
    runtime(&mut db, "a", TaskStatus::Cancelled, false);
    let after = undecided_holds(&db, "ch").unwrap().remove(0);
    assert_eq!(before["id"], after["id"]);
    assert_eq!(after["failed_task_id"], "s");
    let db = approved_failure();
    db.execute(
        "UPDATE wm_task_hold_decisions SET coverage_json='{}' WHERE chain_id='ch'",
        [],
    )
    .unwrap();
    db.execute("UPDATE wm_tasks SET status='waiting' WHERE id='b'", [])
        .unwrap();
    assert!(matches!(ready_tasks(&db, "ch"), Err(Error::Json(_))));
}
// test-category: pure-logic
#[test]
fn stopped_holds_but_blocked_paused_and_last_failures_do_not_ask() {
    for state in [TaskStatus::Stopped, TaskStatus::Blocked, TaskStatus::Paused] {
        let mut db = db();
        queue(&mut db, &["a", "b"]);
        runtime(&mut db, "a", state, false);
        assert_eq!(
            undecided_holds(&db, "ch").unwrap().len(),
            usize::from(state == TaskStatus::Stopped)
        );
    }
    let mut db = db();
    queue(&mut db, &["a"]);
    runtime(&mut db, "a", TaskStatus::Failed, false);
    assert_eq!(
        undecided_holds(&db, "ch").unwrap(),
        Vec::<serde_json::Value>::new()
    );
}
// test-category: pure-logic
#[test]
fn inserted_and_moved_followers_rederive_holds_without_touching_started_tasks() {
    let mut db = db();
    queue(&mut db, &["a", "b"]);
    runtime(&mut db, "a", TaskStatus::Failed, false);
    add(&mut db, "c", "ch", Some("b"), false);
    assert_eq!(read_task(&db, "c").unwrap()["status"], "held");
    add(&mut db, "head", "other", None, false);
    edit(
        &mut db,
        &[QueueEdit::MoveBetween {
            chain_id: "ch".into(),
            target_chain_id: "other".into(),
            task_id: "b".into(),
            placement: butler_canon::work_chain::Placement::Stack(TaskId("head".into())),
        }],
    )
    .unwrap();
    assert_eq!(ready_tasks(&db, "other").unwrap(), vec!["head", "b"]);
    decide(&mut db, Decision::Delete);
    assert_eq!(read_task(&db, "c").unwrap()["status"], "cancelled");
}
