#![allow(clippy::unwrap_used, reason = "test assertions")]
mod store_support;
use butler_work::{store::*, work_types::*};
use serde_json::json;
use store_support::*;

// test-category: pure-logic
#[test]
fn hand_done_barrier_running_rejection_and_cancel_relink() {
    let mut db = db();
    queue(&mut db, &["a", "b", "c"]);
    db.execute_batch("INSERT INTO wm_tasks(id,work_id,spec_ref,title,kind,status,task_rank,created_at,updated_at,created_by) VALUES('pending-task','b','{}','pending','execute','pending','A',0,0,'{}'),('completed-task','b','{}','completed','execute','completed','B',0,0,'{}');").unwrap();
    let tx = db.transaction().unwrap();
    set_label(
        &tx,
        &context(),
        "b",
        revision(&tx, "b"),
        CanonStatus::Done,
        &UserAct::new("tester"),
        Some(graph(&tx, "ch")),
    )
    .unwrap();
    assert_eq!(ready_works(&tx, "ch").unwrap(), vec!["a", "c"]);
    assert_eq!(
        tx.query_row::<(String, String), _, _>(
            "SELECT status,blocked_reason FROM wm_tasks WHERE id='pending-task'",
            [],
            |r| Ok((r.get(0)?, r.get(1)?))
        )
        .unwrap(),
        ("cancelled".into(), "marked done by tester".into())
    );
    assert_eq!(
        tx.query_row::<String, _, _>(
            "SELECT status FROM wm_tasks WHERE id='completed-task'",
            [],
            |r| r.get(0)
        )
        .unwrap(),
        "completed"
    );
    tx.commit().unwrap();
    runtime(&mut db, "a", RunState::Running, false);
    let tx = db.transaction().unwrap();
    assert!(matches!(
        set_label(
            &tx,
            &context(),
            "a",
            revision(&tx, "a"),
            CanonStatus::Done,
            &UserAct::new("tester"),
            Some(graph(&tx, "ch"))
        ),
        Err(Error::Running)
    ));
    tx.rollback().unwrap();
    runtime(&mut db, "a", RunState::Done, true);
    let tx = db.transaction().unwrap();
    set_label(
        &tx,
        &context(),
        "b",
        revision(&tx, "b"),
        CanonStatus::Cancelled,
        &UserAct::new("tester"),
        Some(graph(&tx, "ch")),
    )
    .unwrap();
    assert_eq!(
        read_work(&tx, "b").unwrap()["chain_id"],
        serde_json::Value::Null
    );
    assert_eq!(
        load_chain(&tx, "ch").unwrap().chain.edges().unwrap().len(),
        1
    );
    tx.commit().unwrap();
    {
        let mut db = store_support::db();
        queue(&mut db, &["a", "b", "c"]);
        let old = read_work(&db, "a").unwrap();
        let old_graph = graph(&db, "ch");
        let tx = db.transaction().unwrap();
        edit_queue(
            &tx,
            &context(),
            &[("ch".into(), old_graph)],
            &member_revisions(&tx, "ch"),
            &[QueueEdit::Delete {
                chain_id: "ch".into(),
                work_id: "c".into(),
            }],
        )
        .unwrap();
        tx.commit().unwrap();
        assert_eq!(read_work(&db, "a").unwrap()["revision"], old["revision"]);
        let tx = db.transaction().unwrap();
        assert!(matches!(
            write_api(
                &tx,
                &context(),
                butler_work::store::api::Resource::EditEpic,
                "a",
                json!({"expected_revision":old["revision"],"expected_graph_revision":old_graph,"status":"done"})
            ),
            Err(Error::Conflict { .. })
        ));
    }
}

// test-category: pure-logic
#[test]
fn hold_run_anyway_only_releases_next_step_and_delete_cancels_later() {
    for decision in [Decision::RunAnyway, Decision::Delete] {
        let mut db = db();
        queue(&mut db, &["x", "y", "z"]);
        work(&mut db, "sibling");
        let tx = db.transaction().unwrap();
        place_after(&tx, &context(), "sibling", 0, "y", graph(&tx, "ch")).unwrap();
        edit_queue(
            &tx,
            &context(),
            &[("ch".into(), graph(&tx, "ch"))],
            &member_revisions(&tx, "ch"),
            &[QueueEdit::JoinStack {
                chain_id: "ch".into(),
                work_id: "sibling".into(),
                target: "x".into(),
            }],
        )
        .unwrap();
        tx.commit().unwrap();
        runtime(&mut db, "x", RunState::Failed, false);
        assert_eq!(read_work(&db, "y").unwrap()["run_state"], "held");
        assert_eq!(read_work(&db, "z").unwrap()["run_state"], "held");
        assert_eq!(read_work(&db, "sibling").unwrap()["run_state"], "waiting");
        let rows = undecided_holds(&db, "ch").unwrap();
        assert_eq!(rows.len(), 1);
        let tx = db.transaction().unwrap();
        decide_hold(
            &tx,
            &context(),
            rows[0]["id"].as_str().unwrap(),
            0,
            graph(&tx, "ch"),
            decision,
        )
        .unwrap();
        if decision == Decision::RunAnyway {
            assert_eq!(ready_works(&tx, "ch").unwrap(), vec!["sibling"]);
            transition(
                &tx,
                &context(),
                "sibling",
                revision(&tx, "sibling"),
                RunState::Running,
                false,
                None,
            )
            .unwrap();
            transition(
                &tx,
                &context(),
                "sibling",
                revision(&tx, "sibling"),
                RunState::Done,
                true,
                None,
            )
            .unwrap();
            assert_eq!(ready_works(&tx, "ch").unwrap(), vec!["y"]);
            assert_eq!(read_work(&tx, "z").unwrap()["run_state"], "waiting");
            assert!(!ready_works(&tx, "ch").unwrap().contains(&"z".into()));
        } else {
            assert_eq!(read_work(&tx, "y").unwrap()["run_state"], "cancelled");
            assert_eq!(read_work(&tx, "z").unwrap()["run_state"], "cancelled");
        }
        tx.commit().unwrap();
    }

    let mut db = approved_failure();
    runtime(&mut db, "b", RunState::Done, false);
    assert_eq!(ready_works(&db, "ch").unwrap(), Vec::<String>::new());
    runtime(&mut db, "b", RunState::Done, true);
    assert_eq!(ready_works(&db, "ch").unwrap(), vec!["c"]);
    assert_eq!(
        undecided_holds(&db, "ch").unwrap(),
        Vec::<serde_json::Value>::new()
    );
    runtime(&mut db, "c", RunState::Running, false);
    assert_eq!(chain_state(&db), "active");
    runtime(&mut db, "c", RunState::Done, true);
    assert_eq!(read_work(&db, "a").unwrap()["run_state"], "failed");
    assert_eq!(chain_state(&db), "done");
}

// test-category: pure-logic
#[test]
fn delete_middle_start_new_and_draft_barriers() {
    let mut db = db();
    queue(&mut db, &["a", "b", "c"]);
    let tx = db.transaction().unwrap();
    edit_queue(
        &tx,
        &context(),
        &[("ch".into(), graph(&tx, "ch"))],
        &member_revisions(&tx, "ch"),
        &[QueueEdit::Delete {
            chain_id: "ch".into(),
            work_id: "b".into(),
        }],
    )
    .unwrap();
    assert_eq!(read_work(&tx, "b").unwrap()["run_state"], "idle");
    assert_eq!(read_work(&tx, "b").unwrap()["canon_status"], "planned");
    assert_eq!(
        load_chain(&tx, "ch").unwrap().chain.edges().unwrap()[0]
            .1
            .as_str(),
        "c"
    );
    start_new(
        &tx,
        &context(),
        "a",
        revision(&tx, "a"),
        graph(&tx, "ch"),
        "new-chat",
        "new-chain",
    )
    .unwrap();
    assert_eq!(read_work(&tx, "a").unwrap()["home_session_id"], "new-chat");
    assert_eq!(read_work(&tx, "c").unwrap()["step_index"], 0);
    tx.commit().unwrap();
    work(&mut db, "draft");
    let tx = db.transaction().unwrap();
    let mut fields = WorkFields::from_snapshot(&read_work(&tx, "draft").unwrap()).unwrap();
    fields.draft = true;
    edit_work(&tx, &context(), "draft", revision(&tx, "draft"), &fields).unwrap();
    create_root(
        &tx,
        &context(),
        "draft",
        revision(&tx, "draft"),
        "draft-chain",
        "chat",
        QueueOrigin::Detach,
        None,
    )
    .unwrap();
    assert_eq!(
        ready_works(&tx, "draft-chain").unwrap(),
        Vec::<String>::new()
    );
    tx.commit().unwrap();
}

// test-category: pure-logic
#[test]
fn runtime_label_mapping_only_on_real_transitions() {
    for state in RunState::ALL.iter().filter(|s| **s != RunState::Held) {
        let mut db = db();
        work(&mut db, "a");
        runtime(&mut db, "a", *state, false);
        let expected = runtime_label(*state).unwrap_or(if *state == RunState::Paused {
            CanonStatus::InProgress
        } else {
            CanonStatus::Planned
        });
        assert_eq!(
            read_work(&db, "a").unwrap()["canon_status"],
            expected.as_str()
        );
    }
}
