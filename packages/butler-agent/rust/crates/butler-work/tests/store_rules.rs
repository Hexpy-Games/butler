#![allow(clippy::unwrap_used, reason = "test assertions")]
mod store_support;
use butler_work::{store::*, work_types::*};
use serde_json::json;
use store_support::*;
// test-category: pure-logic
#[test]
fn work_state_is_derived_and_person_labels_survive_no_op_transitions() {
    assigned_part_transitions();
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

fn assigned_part_transitions() {
    use execution::*;
    let mut db = db();
    let tx = Transaction::new(db.transaction().unwrap()).unwrap();
    let scope = apply::ApplyScope {
        session_id: "parent".into(),
        turn_id: "turn".into(),
        instruction_id: "request".into(),
        work_id: None,
        tier: 1,
        planning: false,
        floors: tiers::Floors::default(),
        child_session: false,
    };
    tx.execute("INSERT INTO wm_instructions(id,idempotency_key,target_session_id,sender,mode,body_ref,anchor_kind,anchor_id,boundary_seq,status,received_seq) VALUES('request','request','parent','{}','queue','','turn','turn',0,'applied',0)", []).unwrap();
    let input = serde_json::from_value(json!({"reason":"build", "operations":[
        {"op":"work.create_light","goal":"build", "done_criteria":["runs","verified"],
         "tasks":[[{"key":"task","title":"build","description":"build","criteria":[0,1]}]]},
        {"op":"task.start","task_id":"@task"}]}))
    .unwrap();
    let result = apply::apply(&tx, &context(), &scope, &input).unwrap();
    let task = result["keys"]["task"].as_str().unwrap();
    parts::add_part(
        &tx,
        &context(),
        &parts::NewPart {
            id: "part",
            task_id: task,
            kind: TaskKind::Execute,
            title: "build",
            after_part_ids: &[],
        },
    )
    .unwrap();
    let child = ExecutionScope {
        session_id: "child",
        turn_id: "child-turn",
    };
    assign_part(&tx, &context(), "part", 0, "parent", &child, "attempt").unwrap();
    let refs = vec!["observed".into()];
    let submission = Submission {
        part_id: Some("part"),
        result_id: "result",
        result_refs: &refs,
        evidence_refs: &refs,
    };
    let parent = ExecutionScope {
        session_id: "parent",
        turn_id: "turn",
    };
    assert!(submit_task(&tx, &context(), task, &parent, &submission).is_err());
    assert!(ensure_task_effect(&tx, task, "child").is_ok());
    submit_task(&tx, &context(), task, &child, &submission).unwrap();
    assert_eq!(
        parts::read_part(&tx, "part").unwrap()["status"],
        "completed"
    );
    assert_eq!(read_task(&tx, task).unwrap()["status"], "in_review");
}
