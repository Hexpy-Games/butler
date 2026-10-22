#![allow(clippy::unwrap_used, reason = "test assertions")]
mod store_support;
use butler_work::{store::*, work_types::*};
use serde_json::json;
use store_support::*;
// test-category: pure-logic
#[test]
fn work_state_is_derived_and_person_labels_survive_no_op_transitions() {
    let mut db = db();
    queue(&mut db, &["a", "b"]);
    for (state, expected) in [
        (TaskStatus::Running, "running"),
        (TaskStatus::InReview, "in_review"),
        (TaskStatus::Failed, "failed"),
        (TaskStatus::Running, "running"),
        (TaskStatus::Blocked, "blocked"),
    ] {
        runtime(&mut db, "a", state, false);
        assert_eq!(read_work(&db, "work").unwrap()["run_state"], expected);
    }
    let tx = Transaction::new(db.transaction().unwrap()).unwrap();
    let row = read_work(&tx, "work").unwrap();
    set_label(
        &tx,
        &context(),
        "work",
        row["revision"].as_i64().unwrap(),
        CanonStatus::Planned,
        &UserAct::new("tester"),
        None,
    )
    .unwrap();
    let rev = revision(&tx, "a");
    transition(&tx, &context(), "a", rev, TaskStatus::Blocked, false, None).unwrap();
    assert_eq!(revision(&tx, "a"), rev);
    assert_eq!(
        read_work(&tx, "work").unwrap()["canon_status_source"],
        "person"
    );
}
// test-category: pure-logic
#[test]
fn terminal_labels_cancel_open_tasks_and_parts_with_graph_cas() {
    for label in [CanonStatus::Done, CanonStatus::Cancelled] {
        let mut db = db();
        queue(&mut db, &["a", "b"]);
        db.execute("INSERT INTO wm_task_parts(id,task_id,kind,title,status,part_rank) VALUES('part','b','review','review','pending','A')",[]).unwrap();
        let tx = Transaction::new(db.transaction().unwrap()).unwrap();
        let old = read_work(&tx, "work").unwrap();
        assert!(matches!(
            set_label(
                &tx,
                &context(),
                "work",
                old["revision"].as_i64().unwrap(),
                label,
                &UserAct::new("tester"),
                Some(graph(&tx) - 1)
            ),
            Err(Error::Conflict { .. })
        ));
        let done = set_label(
            &tx,
            &context(),
            "work",
            old["revision"].as_i64().unwrap(),
            label,
            &UserAct::new("tester"),
            Some(graph(&tx)),
        )
        .unwrap();
        assert_eq!(done["run_state"], label.as_str());
        for id in ["a", "b"] {
            let t = read_task(&tx, id).unwrap();
            assert_eq!(t["status"], "cancelled");
            assert!(t["blocked_reason"].is_string());
            assert!(t["chain_id"].is_null());
        }
        assert_eq!(
            tx.query_row::<String, _, _>(
                "SELECT status FROM wm_task_parts WHERE id='part'",
                [],
                |r| r.get(0)
            )
            .unwrap(),
            "cancelled"
        );
    }
}
// test-category: pure-logic
#[test]
fn done_is_rejected_during_execution_and_structure_cas_does_not_need_entity_change() {
    let mut db = db();
    queue(&mut db, &["a", "b", "c"]);
    let old = read_work(&db, "work").unwrap();
    let old_graph = graph(&db);
    edit(
        &mut db,
        &[QueueEdit::Delete {
            chain_id: "ch".into(),
            task_id: "c".into(),
        }],
    )
    .unwrap();
    assert_eq!(read_work(&db, "work").unwrap()["revision"], old["revision"]);
    let tx = Transaction::new(db.transaction().unwrap()).unwrap();
    assert!(matches!(
        write_api(
            &tx,
            &context(),
            butler_work::store::api::Resource::EditEpic,
            "work",
            json!({"expected_revision":old["revision"],"expected_task_graph_revision":old_graph,"status":"done"})
        ),
        Err(Error::Conflict { .. })
    ));
    tx.rollback().unwrap();
    runtime(&mut db, "a", TaskStatus::Running, false);
    let tx = Transaction::new(db.transaction().unwrap()).unwrap();
    let old = read_work(&tx, "work").unwrap();
    assert!(matches!(
        set_label(
            &tx,
            &context(),
            "work",
            old["revision"].as_i64().unwrap(),
            CanonStatus::Done,
            &UserAct::new("tester"),
            Some(graph(&tx))
        ),
        Err(Error::Running)
    ));
}
