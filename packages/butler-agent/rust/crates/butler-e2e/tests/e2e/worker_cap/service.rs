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
        f.create(child, "parent", ChildRole::Worker).await?;
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
        f.create(child, "parent", ChildRole::Worker).await?;
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
async fn cb_11_direction_between_result_commit_and_delivery_keeps_slot() -> Result<(), ServiceError>
{
    butler_e2e::gate!();
    direction_delivery_race(false).await
}

// test-category: race
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn cb_11_applied_continuation_retains_slot_until_completion() -> Result<(), ServiceError> {
    butler_e2e::gate!();
    direction_delivery_race(true).await
}

async fn direction_delivery_race(applied: bool) -> Result<(), ServiceError> {
    let f = Fixture::open().await?;
    for child in ["first", "waiting"] {
        f.create(child, "parent", ChildRole::Worker).await?;
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
    // The result transaction committed, but delivery has not yet cleared the slot.
    f.direction("first").await?;
    f.service.recover_dispatches().await?;
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
        let mut prepared = test_prepared_turn();
        prepared.request.turn_id = turn.clone();
        prepared.request.session_id = "first".into();
        prepared.request.event_id = turn.clone();
        prepared.request.message.id = turn.clone();
        prepared.command = TurnCommand::fixture_run(
            &turn,
            "first",
            &turn,
            CommandMessage {
                message_id: turn.clone(),
                content: "Verify updated evidence".into(),
            },
            json!({}),
        );
        prepared.preparation_id = turn.clone();
        BtccRepositories::new(f.storage.clone(), None)
            .load_or_admit(&prepared)
            .await?;
        assert!(f.service.consume_direction("first", &turn).await?.is_some());
    }
    *f.queue.release.0.lock().unwrap() = true;
    f.queue.release.1.notify_all();
    completing.await.unwrap()?;
    assert_eq!(f.state("first").as_deref(), Some("enqueued"));
    assert_eq!(f.state("waiting").as_deref(), Some("pending"));
    f.service
        .complete_failed_child("first", &turn, "execution_failed")
        .await?;
    assert_eq!(f.state("first"), None);
    assert_eq!(f.state("waiting").as_deref(), Some("enqueued"));
    f.close().await
}

#[tokio::test]
async fn cb_11_failed_first_settings_read_uses_default_ten() -> Result<(), ServiceError> {
    butler_e2e::gate!();
    let f = Fixture::open().await?;
    for index in 0..11 {
        f.create(&format!("worker-{index}"), "parent", ChildRole::Worker)
            .await?;
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
        f.create(child, "parent", ChildRole::Worker).await?;
    }
    f.queue.fail_dispatch.store(true, Ordering::SeqCst);
    assert!(f.service.recover_dispatches().await.is_err());
    assert_eq!(f.state("first").as_deref(), Some("enqueued"));
    f.service.recover_dispatches().await?;
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
    let f = Fixture::open().await?;
    for child in ["first", "waiting"] {
        f.create(child, "parent", ChildRole::Worker).await?;
    }
    f.service.recover_dispatches().await?;
    f.direction("first").await?;
    f.service
        .complete_child("first", "turn-first", "cancelled", "Cancelled".into())
        .await?;
    assert_eq!(f.state("first"), None);
    assert_eq!(f.state("waiting").as_deref(), Some("enqueued"));
    f.close().await
}

#[tokio::test]
async fn cb_11_recovery_continues_after_one_failed_delivery() -> Result<(), ServiceError> {
    butler_e2e::gate!();
    let f = Fixture::open().await?;
    f.create("first", "parent", ChildRole::Worker).await?;
    f.service.recover_dispatches().await?;
    f.queue.fail_delivery.store(true, Ordering::SeqCst);
    assert!(
        f.service
            .complete_failed_child("first", "turn-first", "execution_failed")
            .await
            .is_err()
    );
    f.create("steward-replay", "parent", ChildRole::Steward)
        .await?;
    f.binding("other-parent", butler_turn::workspace::SessionRole::Steward)
        .await?;
    f.create("other-parent", "chat", ChildRole::Steward).await?;
    f.create("other-worker", "other-parent", ChildRole::Worker)
        .await?;
    f.direction("first").await?;
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
