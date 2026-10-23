//! Durable service interleavings with controlled queue and settings boundaries.
use super::*;
type ServiceError = Box<dyn std::error::Error + Send + Sync>;
use butler_turn::{btcc::*, workspace::*};
use std::sync::{
    Arc, Mutex,
    atomic::{AtomicBool, AtomicU64, Ordering},
};

#[path = "service/fixture.rs"]
mod fixture;
use fixture::Fixture;

#[tokio::test]
async fn cb_11_cancel_waiting_writes_result_and_never_starts() -> Result<(), ServiceError> {
    butler_e2e::gate!();
    let f = Fixture::open().await?;
    for child in ["first", "waiting"] {
        f.create(child, "parent", ChildRole::Worker)?;
    }
    f.service.recover_dispatches().await?;
    assert_eq!(f.state("waiting").as_deref(), Some("pending"));
    let output = f
        .service
        .cancel(SubsessionCancelRequest {
            parent_session_id: "parent".into(),
            parent_turn_id: "parent-turn".into(),
            source_message_id: "cancel".into(),
            relation_id: Some("rel-waiting".into()),
            safe_title: None,
            child_role: butler_turn::workspace::SessionRole::Worker,
        })
        .await?;
    assert_eq!(output["status"], "cancelling");
    // Queue consumer handles this control before the first execution exists.
    f.service
        .complete_child("waiting", "turn-waiting", "cancelled", "Cancelled".into())
        .await?;
    let result: String = rusqlite::Connection::open(&f.db)?.query_row(
        "SELECT status FROM btcc_steward_results WHERE relation_id='rel-waiting'",
        [],
        |r| r.get(0),
    )?;
    assert_eq!(result, "cancelled");
    f.service
        .complete_failed_child("first", "turn-first", "execution_failed")
        .await?;
    f.service.recover_dispatches().await?;
    assert_eq!(f.state("waiting"), None);
    assert!(
        !f.queue
            .inputs
            .lock()
            .unwrap()
            .iter()
            .any(|i| i.envelope["eventId"] == "dispatch-waiting")
    );
    f.close().await
}

#[tokio::test]
async fn cb_11_failed_settings_read_uses_last_cap_and_delivers() -> Result<(), ServiceError> {
    butler_e2e::gate!();
    let f = Fixture::open().await?;
    for child in ["first", "second", "third"] {
        f.create(child, "parent", ChildRole::Worker)?;
    }
    f.service.recover_dispatches().await?;
    f.profiles.fail.store(true, Ordering::SeqCst);
    f.service
        .complete_failed_child("first", "turn-first", "execution_failed")
        .await?;
    assert_eq!(f.state("second").as_deref(), Some("enqueued"));
    assert_eq!(f.state("third").as_deref(), Some("pending"));
    assert!(f.queue.inputs.lock().unwrap().iter().any(|i| {
        i.envelope["eventId"]
            .as_str()
            .unwrap_or("")
            .starts_with("worker-result:")
    }));
    f.close().await
}

// test-category: race
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn cb_11_direction_between_result_and_delivery_joins_fifo() -> Result<(), ServiceError> {
    butler_e2e::gate!();
    direction_delivery_race(false).await
}

// test-category: race
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn cb_11_live_continuation_counts_until_completion() -> Result<(), ServiceError> {
    butler_e2e::gate!();
    direction_delivery_race(true).await
}

async fn direction_delivery_race(applied: bool) -> Result<(), ServiceError> {
    let f = Fixture::open().await?;
    for child in ["first", "waiting"] {
        f.create(child, "parent", ChildRole::Worker)?;
    }
    f.service.recover_dispatches().await?;
    f.queue.hold.store(true, Ordering::SeqCst);
    let service = f.service.clone();
    let completing = tokio::spawn(async move {
        service
            .complete_failed_child("first", "turn-first", "execution_failed")
            .await
    });
    tokio::time::timeout(Duration::from_secs(30), f.queue.reached.notified())
        .await
        .unwrap();
    // The result is durable while its parent delivery is held. The older
    // dispatch precedes this newly created continuation in the same FIFO.
    assert_eq!(f.count("parent").await?, 0);
    f.direction("first")?;
    f.service.recover_dispatches().await?;
    assert_eq!(f.state("first").as_deref(), Some("pending"));
    assert_eq!(f.state("waiting").as_deref(), Some("enqueued"));
    assert_eq!(f.count("parent").await?, 1);
    *f.queue.release.0.lock().unwrap() = true;
    f.queue.release.1.notify_all();
    completing.await.unwrap()?;
    f.service
        .complete_failed_child("waiting", "turn-waiting", "execution_failed")
        .await?;
    let turn = f
        .queue
        .inputs
        .lock()
        .unwrap()
        .iter()
        .find_map(|input| {
            (input.envelope["raw"]["source"] == "btcc-subsession-direction").then(|| {
                input.envelope["routingHints"]["turnId"]
                    .as_str()
                    .unwrap()
                    .to_owned()
            })
        })
        .unwrap();
    if applied {
        f.admit_turn("first", &turn).await?;
        assert!(f.service.consume_direction("first", &turn).await?.is_some());
    }
    assert_eq!(f.count("parent").await?, 1);
    f.service
        .complete_failed_child("first", &turn, "execution_failed")
        .await?;
    assert_eq!(f.count("parent").await?, 0);
    f.close().await
}

#[tokio::test]
async fn cb_11_failed_first_settings_read_uses_default_ten() -> Result<(), ServiceError> {
    butler_e2e::gate!();
    let f = Fixture::open().await?;
    for index in 0..11 {
        f.create(&format!("worker-{index}"), "parent", ChildRole::Worker)?;
    }
    f.profiles.fail.store(true, Ordering::SeqCst);
    f.service.recover_dispatches().await?;
    let running = (0..11)
        .filter(|i| f.state(&format!("worker-{i}")).as_deref() == Some("enqueued"))
        .count();
    assert_eq!(running, 10);
    assert_eq!(f.state("worker-10").as_deref(), Some("pending"));
    f.close().await
}

#[tokio::test]
async fn cb_11_admission_replays_after_queue_write_failure() -> Result<(), ServiceError> {
    butler_e2e::gate!();
    let f = Fixture::open().await?;
    for child in ["first", "waiting"] {
        f.create(child, "parent", ChildRole::Worker)?;
    }
    f.queue.fail_dispatch.store(true, Ordering::SeqCst);
    f.service.recover_dispatches().await?;
    assert_eq!(f.state("first").as_deref(), Some("pending"));
    assert_eq!(f.count("parent").await?, 0);
    // A settings change retries without restarting the service.
    f.service.admit_waiting_workers().await?;
    assert!(
        f.queue
            .inputs
            .lock()
            .unwrap()
            .iter()
            .any(|i| i.envelope["eventId"] == "dispatch-first")
    );
    assert_eq!(f.state("waiting").as_deref(), Some("pending"));
    f.service
        .complete_failed_child("first", "turn-first", "execution_failed")
        .await?;
    assert_eq!(f.state("waiting").as_deref(), Some("enqueued"));
    f.close().await
}

#[tokio::test]
async fn cb_11_cancel_running_worker_releases_slot_despite_pending_direction()
-> Result<(), ServiceError> {
    butler_e2e::gate!();
    let mut f = Fixture::open().await?;
    for child in ["first", "waiting"] {
        f.create(child, "parent", ChildRole::Worker)?;
    }
    f.service.recover_dispatches().await?;
    f.direction("first")?;
    f.service
        .complete_child("first", "turn-first", "cancelled", "Cancelled".into())
        .await?;
    assert_eq!(f.state("first").as_deref(), Some("pending"));
    assert_eq!(f.state("waiting").as_deref(), Some("enqueued"));
    f.restart().await?;
    f.service.recover_dispatches().await?;
    assert_eq!(f.state("first").as_deref(), Some("pending"));
    f.service
        .complete_failed_child("waiting", "turn-waiting", "execution_failed")
        .await?;
    assert!(
        f.queue
            .inputs
            .lock()
            .unwrap()
            .iter()
            .any(|i| i.envelope["eventId"] == "subsession-direction:direction")
    );
    assert_eq!(f.count("parent").await?, 1);
    f.close().await
}

#[tokio::test]
async fn cb_11_recovery_continues_after_one_failed_delivery() -> Result<(), ServiceError> {
    butler_e2e::gate!();
    let f = Fixture::open().await?;
    f.create("first", "parent", ChildRole::Worker)?;
    f.service.recover_dispatches().await?;
    f.queue.fail_delivery.store(true, Ordering::SeqCst);
    assert!(
        f.service
            .complete_failed_child("first", "turn-first", "execution_failed")
            .await
            .is_err()
    );
    f.create("steward-replay", "parent", ChildRole::Steward)?;
    f.binding("other-parent", butler_turn::workspace::SessionRole::Steward)
        .await?;
    f.create("other-parent", "chat", ChildRole::Steward)?;
    f.create("other-worker", "other-parent", ChildRole::Worker)?;
    f.direction("first")?;
    f.service.recover_dispatches().await?;
    {
        let inputs = f.queue.inputs.lock().unwrap();
        for event in [
            "dispatch-steward-replay",
            "dispatch-other-worker",
            "subsession-direction:direction",
        ] {
            assert!(
                inputs
                    .iter()
                    .any(|input| input.envelope["eventId"] == event),
                "missing {event}"
            );
        }
    }
    assert_eq!(f.state("other-worker").as_deref(), Some("enqueued"));
    f.close().await
}

#[tokio::test]
async fn cb_11_cancelled_first_turn_followup_uses_continuation() -> Result<(), ServiceError> {
    butler_e2e::gate!();
    let f = Fixture::open().await?;
    f.create("first", "parent", ChildRole::Worker)?;
    f.service.recover_dispatches().await?;
    f.service
        .complete_child("first", "turn-first", "cancelled", "Cancelled".into())
        .await?;
    f.direction("first")?;
    f.service.recover_dispatches().await?;
    let inputs = f.queue.inputs.lock().unwrap();
    assert!(
        inputs
            .iter()
            .any(|i| i.envelope["eventId"] == "subsession-direction:direction")
    );
    assert_eq!(
        inputs
            .iter()
            .filter(|i| i.envelope["eventId"] == "dispatch-first")
            .count(),
        1
    );
    drop(inputs);
    f.close().await
}

// test-category: race
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn cb_11_concurrent_admission_and_completion_never_exceed_cap() -> Result<(), ServiceError> {
    butler_e2e::gate!();
    let f = Fixture::open().await?;
    f.create("first", "parent", ChildRole::Worker)?;
    f.service.recover_dispatches().await?;
    for child in ["second", "third"] {
        f.create(child, "parent", ChildRole::Worker)?;
    }
    let barrier = Arc::new(tokio::sync::Barrier::new(9));
    let mut tasks = Vec::new();
    for index in 0..8 {
        let service = f.service.clone();
        let barrier = barrier.clone();
        tasks.push(tokio::spawn(async move {
            barrier.wait().await;
            if index == 0 {
                service
                    .complete_failed_child("first", "turn-first", "execution_failed")
                    .await?;
            } else {
                service.admit_waiting_workers().await?;
            }
            assert!(
                service
                    .repository()
                    .running_worker_count("parent".into())
                    .await?
                    <= 1
            );
            Ok::<_, ServiceError>(())
        }));
    }
    barrier.wait().await;
    for task in tasks {
        task.await??;
    }
    assert_eq!(f.count("parent").await?, 1);
    assert_eq!(f.state("second").as_deref(), Some("enqueued"));
    assert_eq!(f.state("third").as_deref(), Some("pending"));
    f.close().await
}

#[tokio::test]
async fn cb_11_failed_publish_does_not_block_another_steward() -> Result<(), ServiceError> {
    butler_e2e::gate!();
    let f = Fixture::open().await?;
    f.create("first", "parent", ChildRole::Worker)?;
    f.queue.fail_dispatch.store(true, Ordering::SeqCst);
    f.service.recover_dispatches().await?;
    assert_eq!(f.count("parent").await?, 0);
    f.binding("other-parent", butler_turn::workspace::SessionRole::Steward)
        .await?;
    f.create("other-worker", "other-parent", ChildRole::Worker)?;
    f.service.admit_waiting_workers().await?;
    assert_eq!(f.count("parent").await?, 1);
    assert_eq!(f.count("other-parent").await?, 1);
    f.close().await
}

#[tokio::test]
async fn cb_11_live_historical_worker_counts_without_dispatch_state() -> Result<(), ServiceError> {
    butler_e2e::gate!();
    let f = Fixture::open().await?;
    for child in ["first", "waiting"] {
        f.create(child, "parent", ChildRole::Worker)?;
    }
    f.admit_turn("first", "turn-first").await?;
    rusqlite::Connection::open(&f.db)?.execute("UPDATE btcc_subsession_delegations SET dispatch_state=NULL,dispatch_intent_json=NULL WHERE relation_id='rel-first'", [])?;
    f.service.recover_dispatches().await?;
    assert_eq!(f.count("parent").await?, 1);
    assert_eq!(f.state("waiting").as_deref(), Some("pending"));
    f.service
        .complete_failed_child("first", "turn-first", "execution_failed")
        .await?;
    assert_eq!(f.state("waiting").as_deref(), Some("enqueued"));
    f.close().await
}

#[tokio::test]
async fn cb_11_startup_pending_fifo_uses_creation_then_rowid() -> Result<(), ServiceError> {
    butler_e2e::gate!();
    let mut f = Fixture::open().await?;
    f.profiles.cap.store(2, Ordering::SeqCst);
    for child in ["later", "z-earlier", "a-tied"] {
        f.create(child, "parent", ChildRole::Worker)?;
    }
    rusqlite::Connection::open(&f.db)?.execute("UPDATE btcc_subsession_delegations SET created_at='2026-10-24T00:00:02.000Z' WHERE relation_id='rel-later'", [])?;
    f.restart().await?;
    f.service.recover_dispatches().await?;
    let events: Vec<_> = f
        .queue
        .inputs
        .lock()
        .unwrap()
        .iter()
        .map(|i| i.envelope["eventId"].as_str().unwrap().to_owned())
        .collect();
    assert_eq!(events, ["dispatch-z-earlier", "dispatch-a-tied"]);
    assert_eq!(f.state("later").as_deref(), Some("pending"));
    assert_eq!(f.count("parent").await?, 2);
    f.close().await
}

#[tokio::test]
async fn cb_11_old_reservation_columns_are_ignored_across_reopens() -> Result<(), ServiceError> {
    butler_e2e::gate!();
    let mut f = Fixture::open().await?;
    for child in ["first", "waiting"] {
        f.create(child, "parent", ChildRole::Worker)?;
    }
    rusqlite::Connection::open(&f.db)?.execute_batch("ALTER TABLE btcc_subsession_delegations ADD COLUMN slot_release_result_id TEXT; ALTER TABLE btcc_subsession_delegations ADD COLUMN parent_session_id TEXT; ALTER TABLE btcc_subsession_delegations ADD COLUMN child_role TEXT; UPDATE btcc_subsession_delegations SET slot_release_result_id='old-result',parent_session_id='old-parent',child_role='steward';")?;
    f.restart().await?;
    f.restart().await?;
    f.service.recover_dispatches().await?;
    assert_eq!(f.count("parent").await?, 1);
    assert_eq!(f.state("waiting").as_deref(), Some("pending"));
    f.service
        .complete_failed_child("first", "turn-first", "execution_failed")
        .await?;
    assert_eq!(f.count("parent").await?, 1);
    assert_eq!(f.state("waiting").as_deref(), Some("enqueued"));
    f.close().await
}

#[tokio::test]
async fn cb_11_binding_failure_returns_pending_until_next_change() -> Result<(), ServiceError> {
    butler_e2e::gate!();
    let f = Fixture::open().await?;
    f.create("first", "unbound-parent", ChildRole::Worker)?;
    f.service.admit_waiting_workers().await?;
    assert_eq!(f.state("first").as_deref(), Some("pending"));
    assert_eq!(f.count("unbound-parent").await?, 0);
    f.binding(
        "unbound-parent",
        butler_turn::workspace::SessionRole::Steward,
    )
    .await?;
    f.service.admit_waiting_workers().await?;
    assert_eq!(f.state("first").as_deref(), Some("enqueued"));
    assert_eq!(f.count("unbound-parent").await?, 1);
    f.close().await
}

// test-category: race
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn cb_11_late_publish_failure_cannot_retire_a_new_continuation() -> Result<(), ServiceError> {
    butler_e2e::gate!();
    let f = Fixture::open().await?;
    f.create("first", "parent", ChildRole::Worker)?;
    f.queue.hold_dispatch.store(true, Ordering::SeqCst);
    let service = f.service.clone();
    let publishing = tokio::spawn(async move { service.recover_dispatches().await });
    tokio::time::timeout(Duration::from_secs(30), f.queue.reached.notified())
        .await
        .unwrap();
    f.service
        .complete_child("first", "turn-first", "cancelled", "Cancelled".into())
        .await?;
    f.direction("first")?;
    f.service.admit_waiting_workers().await?;
    assert_eq!(f.count("parent").await?, 1);
    *f.queue.release.0.lock().unwrap() = true;
    f.queue.release.1.notify_all();
    publishing.await??;
    assert_eq!(f.count("parent").await?, 1);
    assert_eq!(f.state("first").as_deref(), Some("enqueued"));
    f.close().await
}
