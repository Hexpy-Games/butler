#![allow(clippy::unwrap_used, reason = "test assertions")]
mod store_support;
use butler_work::{store::*, work_types::*};
use store_support::*;
fn attempt(db: &rusqlite::Connection) {
    db.execute_batch("INSERT INTO wm_tasks(id,work_id,spec_ref,title,kind,status,task_rank,created_at,updated_at,created_by) VALUES('task','a','{}','task','execute','running','V',0,0,'{}');
    INSERT INTO wm_attempts(id,task_id,task_revision,spec_ref,session_id,lease_epoch,status,started_at) VALUES('attempt','task',0,'{}','chat',1,'interrupted',0);").unwrap();
}
// test-category: pure-logic
#[test]
fn crash_holds_full_queue_and_clean_restart_keeps_steps_and_requeues_tasks() {
    for previous in [PreviousShutdown::Clean, PreviousShutdown::Crash] {
        let mut db = db();
        queue(&mut db, &["a", "b", "c"]);
        runtime(&mut db, "a", RunState::Running, false);
        attempt(&db);
        let tx = db.transaction().unwrap();
        recover_session(&tx, &context(), "chat", previous).unwrap();
        assert_eq!(read_work(&tx, "a").unwrap()["step_index"], 0);
        assert_eq!(load_chain(&tx, "ch").unwrap().chain.steps.len(), 3);
        if previous == PreviousShutdown::Crash {
            assert_eq!(
                read_work(&tx, "a").unwrap()["failure_reason"],
                "interrupted_by_crash"
            );
            assert_eq!(read_work(&tx, "c").unwrap()["run_state"], "held");
            assert_eq!(undecided_holds(&tx, "ch").unwrap().len(), 1);
        } else {
            assert_eq!(read_work(&tx, "a").unwrap()["run_state"], "waiting");
            assert_eq!(
                tx.query_row::<String, _, _>(
                    "SELECT status FROM wm_tasks WHERE id='task'",
                    [],
                    |r| r.get(0)
                )
                .unwrap(),
                "pending"
            );
            assert_eq!(
                undecided_holds(&tx, "ch").unwrap(),
                Vec::<serde_json::Value>::new()
            );
        }
        tx.commit().unwrap();
    }
}
// test-category: pure-logic
#[test]
fn no_op_runtime_transition_preserves_person_label_and_done_requires_reporting() {
    let mut db = db();
    queue(&mut db, &["a", "b"]);
    runtime(&mut db, "a", RunState::Running, false);
    let tx = db.transaction().unwrap();
    set_label(
        &tx,
        &context(),
        "a",
        revision(&tx, "a"),
        CanonStatus::Planned,
        &UserAct::new("tester"),
        Some(graph(&tx, "ch")),
    )
    .unwrap();
    let current = revision(&tx, "a");
    transition(
        &tx,
        &context(),
        "a",
        current,
        RunState::Running,
        false,
        None,
    )
    .unwrap();
    assert_eq!(revision(&tx, "a"), current);
    assert_eq!(
        read_work(&tx, "a").unwrap()["canon_status_source"],
        "person"
    );
    transition(&tx, &context(), "a", current, RunState::Done, false, None).unwrap();
    assert_eq!(ready_works(&tx, "ch").unwrap(), Vec::<String>::new());
    let graph_before = graph(&tx, "ch");
    transition(
        &tx,
        &context(),
        "a",
        revision(&tx, "a"),
        RunState::Done,
        true,
        None,
    )
    .unwrap();
    assert_eq!(ready_works(&tx, "ch").unwrap(), vec!["b"]);
    assert_eq!(graph(&tx, "ch"), graph_before + 1);
    tx.commit().unwrap();
}
// test-category: pure-logic
#[test]
fn stopped_holds_but_paused_and_blocked_do_not() {
    for state in [RunState::Stopped, RunState::Paused, RunState::Blocked] {
        let mut db = db();
        queue(&mut db, &["a", "b", "c"]);
        runtime(&mut db, "a", state, false);
        let held = state == RunState::Stopped;
        assert_eq!(
            read_work(&db, "c").unwrap()["run_state"],
            if held { "held" } else { "waiting" }
        );
        assert_eq!(undecided_holds(&db, "ch").unwrap().len(), usize::from(held));
    }
}
// test-category: pure-logic
#[test]
fn failed_batch_rolls_back_membership_edges_events_counts_and_graph_revision() {
    let mut db = db();
    queue(&mut db, &["a", "b", "c"]);
    let before = graph(&db, "ch");
    let tx = db.transaction().unwrap();
    let before_events: i64 = tx
        .query_row("SELECT count(*) FROM wm_audit", [], |r| r.get(0))
        .unwrap();
    let result = edit_queue(
        &tx,
        &context(),
        &[("ch".into(), before)],
        &member_revisions(&tx, "ch"),
        &[
            QueueEdit::Delete {
                chain_id: "ch".into(),
                work_id: "b".into(),
            },
            QueueEdit::Detach {
                chain_id: "ch".into(),
                work_id: "c".into(),
                new_chain_id: "ch".into(),
            },
        ],
    );
    assert!(result.is_err());
    assert_eq!(graph(&tx, "ch"), before);
    assert_eq!(load_chain(&tx, "ch").unwrap().chain.steps.len(), 3);
    assert_eq!(read_work(&tx, "b").unwrap()["run_state"], "waiting");
    assert_eq!(
        tx.query_row::<i64, _, _>("SELECT count(*) FROM wm_audit", [], |r| r.get(0))
            .unwrap(),
        before_events
    );
    assert_eq!(tx.query_row::<i64,_,_>("SELECT count FROM wm_counts WHERE scope_kind='session' AND scope_ref='chat' AND key='run_state:waiting'",[],|r|r.get(0)).unwrap(),3);
    tx.commit().unwrap();
}
// test-category: pure-logic
#[test]
fn recovered_attempt_is_not_recovered_again_after_a_later_crash() {
    let mut db = db();
    queue(&mut db, &["a", "b"]);
    runtime(&mut db, "a", RunState::Running, false);
    attempt(&db);
    let tx = db.transaction().unwrap();
    recover_session(&tx, &context(), "chat", PreviousShutdown::Clean).unwrap();
    let after = read_work(&tx, "a").unwrap();
    recover_session(&tx, &context(), "chat", PreviousShutdown::Crash).unwrap();
    assert_eq!(read_work(&tx, "a").unwrap(), after);
    assert_eq!(
        undecided_holds(&tx, "ch").unwrap(),
        Vec::<serde_json::Value>::new()
    );
    tx.commit().unwrap();
}
// test-category: pure-logic
#[test]
fn terminal_step_failure_leaves_no_question_and_active_chain() {
    let mut db = db();
    queue(&mut db, &["a"]);
    runtime(&mut db, "a", RunState::Failed, false);
    assert!(undecided_holds(&db, "ch").unwrap().is_empty());
    assert_eq!(
        db.query_row::<String, _, _>("SELECT state FROM wm_work_chains WHERE id='ch'", [], |r| r
            .get(0))
            .unwrap(),
        "active"
    );
}
// test-category: pure-logic
#[test]
fn person_done_on_a_failed_work_satisfies_its_follower_barrier() {
    let mut db = db();
    queue(&mut db, &["a", "b", "c"]);
    runtime(&mut db, "a", RunState::Failed, false);
    let tx = db.transaction().unwrap();
    set_label(
        &tx,
        &context(),
        "a",
        revision(&tx, "a"),
        CanonStatus::Done,
        &UserAct::new("tester"),
        Some(graph(&tx, "ch")),
    )
    .unwrap();
    assert_eq!(ready_works(&tx, "ch").unwrap(), vec!["b"]);
    assert_eq!(read_work(&tx, "c").unwrap()["run_state"], "waiting");
    tx.commit().unwrap();
}
