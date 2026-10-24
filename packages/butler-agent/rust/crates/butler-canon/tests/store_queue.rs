#![allow(clippy::unwrap_used, reason = "test assertions")]
mod store_support;
use butler_canon::{store::*, work_chain::Placement, work_types::*};
use store_support::*;
// test-category: pure-logic
#[test]
fn edit_shapes_relink_and_pin_running_tasks() {
    let mut db = db();
    queue(&mut db, &["a", "b", "c"]);
    add(&mut db, "d", "other", None, false);
    edit(
        &mut db,
        &[QueueEdit::MoveBetween {
            chain_id: "ch".into(),
            target_chain_id: "other".into(),
            task_id: "b".into(),
            placement: Placement::Stack(TaskId("d".into())),
        }],
    )
    .unwrap();
    assert_eq!(
        load_chain(&db, "ch").unwrap().chain.edges().unwrap(),
        vec![(TaskId("a".into()), TaskId("c".into()))]
    );
    edit(
        &mut db,
        &[
            QueueEdit::SplitStack {
                chain_id: "other".into(),
                index: 0,
            },
            QueueEdit::Detach {
                chain_id: "other".into(),
                task_id: "b".into(),
                new_chain_id: "new".into(),
            },
        ],
    )
    .unwrap();
    assert_eq!(read_task(&db, "b").unwrap()["origin"], "detach");
    assert_eq!(ready_tasks(&db, "new").unwrap(), vec!["b"]);
    runtime(&mut db, "d", TaskStatus::Failed, false);
    edit(
        &mut db,
        &[QueueEdit::Detach {
            chain_id: "other".into(),
            task_id: "d".into(),
            new_chain_id: "retry".into(),
        }],
    )
    .unwrap();
    assert_eq!(ready_tasks(&db, "retry").unwrap(), vec!["d"]);
    assert_eq!(read_task(&db, "d").unwrap()["status"], "pending");
    runtime(&mut db, "a", TaskStatus::Running, false);
    let before = graph(&db);
    assert!(
        edit(
            &mut db,
            &[QueueEdit::MoveToNewStep {
                chain_id: "ch".into(),
                task_id: "a".into(),
                index: 1
            }]
        )
        .is_err()
    );
    assert_eq!(graph(&db), before);
    edit(
        &mut db,
        &[QueueEdit::Delete {
            chain_id: "ch".into(),
            task_id: "c".into(),
        }],
    )
    .unwrap();
    assert_eq!(read_task(&db, "c").unwrap()["status"], "cancelled");
}
// test-category: pure-logic
#[test]
fn drafts_barriers_and_cancelled_relink() {
    let mut db = db();
    queue(&mut db, &["a", "b", "c"]);
    add(&mut db, "draft", "draft", None, true);
    assert_eq!(ready_tasks(&db, "draft").unwrap(), Vec::<String>::new());
    let tx = Transaction::new(db.transaction().unwrap()).unwrap();
    assert!(
        transition(
            &tx,
            &context(),
            "draft",
            revision(&tx, "draft"),
            TaskStatus::Running,
            false,
            None
        )
        .is_err()
    );
    assert!(
        transition(
            &tx,
            &context(),
            "a",
            revision(&tx, "a"),
            TaskStatus::Completed,
            true,
            None
        )
        .is_err()
    );
    tx.rollback().unwrap();
    runtime(&mut db, "a", TaskStatus::Completed, false);
    assert_eq!(ready_tasks(&db, "ch").unwrap(), Vec::<String>::new());
    runtime(&mut db, "a", TaskStatus::Completed, true);
    assert_eq!(ready_tasks(&db, "ch").unwrap(), vec!["b"]);
    runtime(&mut db, "b", TaskStatus::Cancelled, false);
    assert_eq!(ready_tasks(&db, "ch").unwrap(), vec!["c"]);
    assert_eq!(load_chain(&db, "ch").unwrap().chain.steps.len(), 2);
}
// test-category: pure-logic
#[test]
fn cross_work_moves_and_partial_batches_are_rejected() {
    let mut db = db();
    queue(&mut db, &["a", "b", "c"]);
    work(&mut db, "other");
    db.execute(
        "INSERT INTO wm_task_chains(id,work_id,created_at) VALUES('foreign','other',0)",
        [],
    )
    .unwrap();
    let before = read_task(&db, "b").unwrap();
    let revision = graph(&db);
    assert!(
        edit(
            &mut db,
            &[QueueEdit::MoveBetween {
                chain_id: "ch".into(),
                target_chain_id: "foreign".into(),
                task_id: "b".into(),
                placement: Placement::NewStep(0)
            }]
        )
        .is_err()
    );
    assert!(
        edit(
            &mut db,
            &[
                QueueEdit::Delete {
                    chain_id: "ch".into(),
                    task_id: "b".into()
                },
                QueueEdit::Delete {
                    chain_id: "ch".into(),
                    task_id: "missing".into()
                }
            ]
        )
        .is_err()
    );
    assert_eq!(read_task(&db, "b").unwrap(), before);
    assert_eq!(graph(&db), revision);
}
