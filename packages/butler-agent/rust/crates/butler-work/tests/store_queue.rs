#![allow(clippy::unwrap_used, reason = "test assertions")]
mod store_support;
use butler_work::{store::*, work_chain::Placement, work_types::*};
use store_support::*;
// test-category: pure-logic
#[test]
fn stack_failures_share_one_question_and_bypass_only_that_barrier() {
    let mut db = db();
    queue(&mut db, &["a", "b", "c"]);
    work(&mut db, "sibling");
    let tx = db.transaction().unwrap();
    place_after(&tx, &context(), "sibling", 0, "b", graph(&tx, "ch")).unwrap();
    edit_queue(
        &tx,
        &context(),
        &[("ch".into(), graph(&tx, "ch"))],
        &member_revisions(&tx, "ch"),
        &[QueueEdit::JoinStack {
            chain_id: "ch".into(),
            work_id: "sibling".into(),
            target: "a".into(),
        }],
    )
    .unwrap();
    tx.commit().unwrap();
    runtime(&mut db, "a", RunState::Failed, false);
    runtime(&mut db, "sibling", RunState::Failed, false);
    let pending = undecided_holds(&db, "ch").unwrap();
    assert_eq!(pending.len(), 1);
    let tx = db.transaction().unwrap();
    decide_hold(
        &tx,
        &context(),
        pending[0]["id"].as_str().unwrap(),
        pending[0]["revision"].as_i64().unwrap(),
        graph(&tx, "ch"),
        Decision::RunAnyway,
    )
    .unwrap();
    assert_eq!(ready_works(&tx, "ch").unwrap(), vec!["b"]);
    assert_eq!(read_work(&tx, "c").unwrap()["run_state"], "held");
    tx.commit().unwrap();
}
// test-category: pure-logic
#[test]
fn move_between_detach_split_and_cross_chat_rejection_are_atomic() {
    let mut db = db();
    queue(&mut db, &["a", "b", "c"]);
    work(&mut db, "d");
    let tx = db.transaction().unwrap();
    create_root(
        &tx,
        &context(),
        "d",
        0,
        "other",
        "chat",
        QueueOrigin::Schedule,
        None,
    )
    .unwrap();
    let mut works = member_revisions(&tx, "ch");
    works.extend(member_revisions(&tx, "other"));
    edit_queue(
        &tx,
        &context(),
        &[
            ("ch".into(), graph(&tx, "ch")),
            ("other".into(), graph(&tx, "other")),
        ],
        &works,
        &[QueueEdit::MoveBetween {
            chain_id: "ch".into(),
            target_chain_id: "other".into(),
            work_id: "b".into(),
            placement: Placement::Stack(WorkId("d".into())),
        }],
    )
    .unwrap();
    assert_eq!(
        load_chain(&tx, "other").unwrap().chain.steps[0].works.len(),
        2
    );
    edit_queue(
        &tx,
        &context(),
        &[("other".into(), graph(&tx, "other"))],
        &member_revisions(&tx, "other"),
        &[
            QueueEdit::SplitStack {
                chain_id: "other".into(),
                index: 0,
            },
            QueueEdit::Detach {
                chain_id: "other".into(),
                work_id: "b".into(),
                new_chain_id: "detached".into(),
            },
        ],
    )
    .unwrap();
    assert_eq!(read_work(&tx, "b").unwrap()["queue_origin"], "detach");
    assert_eq!(ready_works(&tx, "detached").unwrap(), vec!["b"]);
    tx.commit().unwrap();
    work(&mut db, "e");
    let tx = db.transaction().unwrap();
    start_new(&tx, &context(), "e", 0, 0, "different-chat", "different").unwrap();
    let mut works = member_revisions(&tx, "ch");
    works.extend(member_revisions(&tx, "different"));
    assert!(matches!(
        edit_queue(
            &tx,
            &context(),
            &[
                ("ch".into(), graph(&tx, "ch")),
                ("different".into(), graph(&tx, "different"))
            ],
            &works,
            &[QueueEdit::MoveBetween {
                chain_id: "ch".into(),
                target_chain_id: "different".into(),
                work_id: "c".into(),
                placement: Placement::NewStep(1)
            }]
        ),
        Err(Error::CrossChat)
    ));
    assert_eq!(read_work(&tx, "c").unwrap()["chain_id"], "ch");
    tx.commit().unwrap();
}
// test-category: pure-logic
#[test]
fn running_pins_reject_queue_changes_and_start_new() {
    let mut db = db();
    queue(&mut db, &["a", "b", "c"]);
    runtime(&mut db, "a", RunState::Running, false);
    let tx = db.transaction().unwrap();
    assert!(matches!(
        start_new(
            &tx,
            &context(),
            "a",
            revision(&tx, "a"),
            graph(&tx, "ch"),
            "new-chat",
            "new-chain"
        ),
        Err(Error::Running)
    ));
    assert!(matches!(
        edit_queue(
            &tx,
            &context(),
            &[("ch".into(), graph(&tx, "ch"))],
            &member_revisions(&tx, "ch"),
            &[QueueEdit::MoveToNewStep {
                chain_id: "ch".into(),
                work_id: "a".into(),
                index: 1
            }]
        ),
        Err(Error::Chain(_))
    ));
    tx.commit().unwrap();
}
// test-category: pure-logic
#[test]
fn imported_scope_counts_initialize_from_indexed_rows_and_update_by_delta() {
    let mut db = db();
    db.execute_batch("INSERT INTO wm_works(id,scope_kind,scope_ref,title,visibility,origin,created_at,updated_at,created_by) VALUES('old','session','chat','old','private','migration',0,0,'{}');").unwrap();
    work(&mut db, "new");
    runtime(&mut db, "old", RunState::Done, true);
    assert_eq!(db.query_row::<i64,_,_>("SELECT count FROM wm_counts WHERE scope_kind='session' AND scope_ref='chat' AND key='works'",[],|r|r.get(0)).unwrap(),2);
    assert_eq!(db.query_row::<i64,_,_>("SELECT count FROM wm_counts WHERE scope_kind='session' AND scope_ref='chat' AND key='run_state:idle'",[],|r|r.get(0)).unwrap(),1);
}
