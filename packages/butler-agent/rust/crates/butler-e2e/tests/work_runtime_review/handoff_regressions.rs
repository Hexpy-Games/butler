//! Ownership window regressions on the real BTCC writer lane.
use super::*;

// test-category: race
#[tokio::test]
async fn parts_reject_submit_fail_and_block_during_handoff() -> std::result::Result<(), Failure> {
    butler_e2e::gate!();
    for operation in ["submit", "fail", "block"] {
        let (_fixture, storage) = open().await?;
        storage
            .work_model_write(move |tx| {
                let task = read_part(tx, "first")?["task_id"]
                    .as_str()
                    .unwrap()
                    .to_owned();
                let revision = read_task(tx, &task)?["revision"].as_i64().unwrap();
                take_here(tx, &context(), &task, "new-owner", revision)?;
                let before = read_task(tx, &task)?;
                let result = match operation {
                    "submit" => submit_task(
                        tx,
                        &context(),
                        &task,
                        &ExecutionScope {
                            session_id: "first",
                            turn_id: "first",
                        },
                        &Submission {
                            part_id: Some("first"),
                            result_id: "late",
                            result_refs: &["output".into()],
                            evidence_refs: &["verified".into()],
                        },
                    ),
                    "fail" => fail_part(tx, &context(), "first", "first", "Cannot finish"),
                    _ => block_task(
                        tx,
                        &context(),
                        &task,
                        Some("first"),
                        "first",
                        "Needs input",
                        None,
                    ),
                };
                assert!(
                    matches!(result, Err(Error::Invalid("handoff_in_progress"))),
                    "{operation}: {result:?}"
                );
                assert_eq!(read_task(tx, &task)?, before);
                assert_eq!(read_part(tx, "first")?["status"], "running");
                Ok(())
            })
            .await?;
        storage.close().await?;
    }
    Ok(())
}

// test-category: race
#[tokio::test]
async fn terminal_transition_releases_handoff_without_moving_owner()
-> std::result::Result<(), Failure> {
    butler_e2e::gate!();
    for status in [
        butler_work::work_types::TaskStatus::Cancelled,
        butler_work::work_types::TaskStatus::Failed,
    ] {
        let (_fixture, storage) = open().await?;
        storage
            .work_model_write(move |tx| {
                let task = read_part(tx, "first")?["task_id"]
                    .as_str()
                    .unwrap()
                    .to_owned();
                take_here(
                    tx,
                    &context(),
                    &task,
                    "next",
                    read_task(tx, &task)?["revision"].as_i64().unwrap(),
                )?;
                transition(
                    tx,
                    &context(),
                    &task,
                    read_task(tx, &task)?["revision"].as_i64().unwrap(),
                    status,
                    false,
                    Some("Cannot finish"),
                )?;
                assert!(read_task(tx, &task)?["handoff_to_session_id"].is_null());
                assert!(active_session_holds(tx, "parent")?.is_empty());
                let checkpoint = put_body(tx, "Retained progress")?;
                complete_handoff(tx, &context(), &task, &checkpoint)?;
                assert_eq!(read_task(tx, &task)?["assignee_session_id"], "parent");
                Ok(())
            })
            .await?;
        storage.close().await?;
    }
    Ok(())
}

// test-category: race
#[tokio::test]
async fn scheduler_cannot_assign_a_reservation_claimed_by_a_person()
-> std::result::Result<(), Failure> {
    butler_e2e::gate!();
    let (_fixture, storage) = open().await?;
    storage
        .work_model_write(|tx| {
            let task = read_part(tx, "first")?["task_id"]
                .as_str()
                .unwrap()
                .to_owned();
            tx.execute("UPDATE wm_tasks SET status='pending' WHERE id=?1", [&task])?;
            tx.execute(
                "UPDATE wm_attempts SET status='interrupted' WHERE task_id=?1",
                [&task],
            )?;
            take_here(
                tx,
                &context(),
                &task,
                "person",
                read_task(tx, &task)?["revision"].as_i64().unwrap(),
            )?;
            let current = read_task(tx, &task)?;
            let result = assign_task(
                tx,
                &context(),
                &task,
                current["revision"].as_i64().unwrap(),
                &ExecutionScope {
                    session_id: "stale-reservation",
                    turn_id: "turn",
                },
                "attempt",
            );
            assert!(matches!(result, Err(Error::Conflict { .. })), "{result:?}");
            assert_eq!(read_task(tx, &task)?, current);
            Ok(())
        })
        .await?;
    storage.close().await?;
    Ok(())
}

// test-category: race
#[tokio::test]
async fn cancellation_and_part_failure_race_a_handoff() -> std::result::Result<(), Failure> {
    butler_e2e::gate!();
    for cancel in [false, true] {
        let (_fixture, storage) = open().await?;
        let (task, revision) = storage
            .work_model_read(|db| {
                let task = read_part(db, "first")?["task_id"]
                    .as_str()
                    .unwrap()
                    .to_owned();
                let revision = read_task(db, &task)?["revision"].as_i64().unwrap();
                Ok((task, revision))
            })
            .await?;
        let moving = task.clone();
        let settling = task.clone();
        let (moved, settled) = tokio::join!(
            storage.work_model_write(move |tx| take_here(
                tx,
                &context(),
                &moving,
                "next",
                revision
            )),
            storage.work_model_write(move |tx| {
                if cancel {
                    transition(
                        tx,
                        &context(),
                        &settling,
                        read_task(tx, &settling)?["revision"].as_i64().unwrap(),
                        butler_work::work_types::TaskStatus::Cancelled,
                        false,
                        None,
                    )
                } else {
                    fail_part(tx, &context(), "first", "first", "Cannot finish")?;
                    fail_part(tx, &context(), "second", "second", "Cannot finish")
                }
            })
        );
        assert!(moved.is_ok() || settled.is_ok());
        if cancel {
            assert!(settled.is_ok());
        }
        storage
            .work_model_write(move |tx| {
                let row = read_task(tx, &task)?;
                if !row["handoff_to_session_id"].is_null() {
                    assert!(!cancel);
                    assert!(moved.is_ok() && settled.is_err());
                    let checkpoint = put_body(tx, "Retained output")?;
                    complete_handoff(tx, &context(), &task, &checkpoint)?;
                } else {
                    assert!(settled.is_ok());
                    assert!(row["status"] == "cancelled" || row["status"] == "failed");
                    assert_eq!(row["assignee_session_id"], "parent");
                }
                assert!(active_session_holds(tx, "parent")?.is_empty());
                Ok(())
            })
            .await?;
        storage.close().await?;
    }
    Ok(())
}

// test-category: race
#[tokio::test]
async fn old_terminal_handoffs_release_the_hold_without_resurrecting_the_task()
-> std::result::Result<(), Failure> {
    butler_e2e::gate!();
    for status in ["failed", "cancelled", "completed"] {
        let (_fixture, storage) = open().await?;
        storage.work_model_write(move |tx| {
            let task=read_part(tx,"first")?["task_id"].as_str().unwrap().to_owned();
            take_here(tx,&context(),&task,"next",read_task(tx,&task)?["revision"].as_i64().unwrap())?;
            tx.execute("UPDATE wm_tasks SET status=?2,failure_reason=CASE WHEN ?2='failed' THEN 'Failed' ELSE NULL END WHERE id=?1",rusqlite::params![task,status])?;
            let epoch=read_task(tx,&task)?["owner_epoch"].clone();
            let checkpoint=put_body(tx,"Retained output")?;
            complete_handoff(tx,&context(),&task,&checkpoint)?;
            let row=read_task(tx,&task)?;
            assert_eq!(row["status"],status);
            assert_eq!(row["owner_epoch"],epoch);
            assert_eq!(row["assignee_session_id"],"parent");
            assert!(row["handoff_to_session_id"].is_null());
            assert!(active_session_holds(tx,"parent")?.is_empty());
            Ok(())
        }).await?;
        storage.close().await?;
    }
    Ok(())
}
