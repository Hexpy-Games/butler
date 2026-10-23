//! Review regressions use the real service and durable assignment store.
use super::*;

// test-category: race
#[tokio::test]
async fn steer_waiting_worker_stays_behind_brief_even_after_recovery()
-> std::result::Result<(), Failure> {
    butler_e2e::gate!();
    let f = Fixture::open().await?;
    let first = f.service.delegate_worker(request("First")).await?;
    let waiting = f.service.delegate_worker(request("Second")).await?;
    let mut steer: SessionControlRequest = serde_json::from_value(json!({
        "target_session_id":waiting["child_session_id"],"mode":"steer",
        "instruction":{"text":"Keep the report concise"},
        "expected_control_epoch":0,"idempotency_key":"steer-waiting"
    }))?;
    steer.parent_session_id = "parent".into();
    f.service.session_control(steer).await?;
    assert_eq!(f.counts().await?, (1, 1));
    assert_eq!(
        f.queue.0.lock().unwrap().len(),
        1,
        "steer must not start a waiting worker"
    );
    f.service.recover_native_assignments(vec![]).await?;
    f.service.recover_waiting_workers().await?;
    assert_eq!(
        f.queue.0.lock().unwrap().len(),
        1,
        "recovery must hold the direction too"
    );
    f.finish(&first, "success").await?;
    assert_eq!(f.counts().await?, (1, 0));
    assert_eq!(f.queue.0.lock().unwrap().len(), 2);
    f.finish(&waiting, "failed").await?;
    let envelopes = f.queue.1.lock().unwrap().clone();
    assert_eq!(envelopes.len(), 3);
    assert_eq!(
        envelopes[1]["routingHints"]["sessionId"],
        waiting["child_session_id"]
    );
    assert_eq!(envelopes[2]["raw"]["source"], "btcc-subsession-direction");
    assert!(
        envelopes[2]["message"]["text"]
            .as_str()
            .unwrap()
            .contains("Keep the report concise")
    );
    f.close().await
}

// test-category: race
#[tokio::test]
async fn settings_failure_does_not_suppress_parent_completion() -> std::result::Result<(), Failure>
{
    butler_e2e::gate!();
    let f = Fixture::open().await?;
    let first = f.service.delegate_worker(request("First")).await?;
    let second = f.service.delegate_worker(request("Second")).await?;
    let mut changes = f.service.subscribe_changes();
    f.profiles.1.store(true, Ordering::SeqCst);
    f.finish(&first, "success").await?;
    assert_eq!(
        changes.try_recv()?,
        (
            "parent".into(),
            first["child_session_id"].as_str().unwrap().into()
        )
    );
    let projection = f.service.app_projection("parent").await?;
    assert_eq!(
        projection["workers"][0]["result"]["summary"], "report",
        "{projection}"
    );
    assert_eq!(f.counts().await?, (0, 1));
    f.profiles.1.store(false, Ordering::SeqCst);
    f.service.recover_native_assignments(vec![]).await?;
    f.service.recover_waiting_workers().await?;
    assert_eq!(f.counts().await?, (1, 0));
    assert_eq!(
        f.queue.0.lock().unwrap().last().unwrap(),
        second["child_session_id"].as_str().unwrap()
    );
    f.close().await
}

// test-category: race
#[tokio::test]
async fn startup_replay_waits_for_app_readiness() -> std::result::Result<(), Failure> {
    butler_e2e::gate!();
    let f = Fixture::open().await?;
    f.service.delegate_worker(request("First")).await?;
    let second = f.service.delegate_worker(request("Second")).await?;
    f.profiles.0.store(2, Ordering::SeqCst);
    f.profiles.2.send_replace(false);
    let service = f.service.clone();
    let recovered = service.recover_waiting_workers();
    tokio::pin!(recovered);
    tokio::select! {
        result = &mut recovered => panic!("replay completed before App readiness: {result:?}"),
        () = f.profiles.3.notified() => {}
    }
    assert_eq!(f.counts().await?, (1, 1));
    f.profiles.2.send_replace(true);
    recovered.await?;
    assert_eq!(f.counts().await?, (2, 0));
    assert_eq!(
        f.queue.0.lock().unwrap().last().unwrap(),
        second["child_session_id"].as_str().unwrap()
    );
    f.close().await
}

// test-category: race
#[tokio::test]
async fn same_millisecond_dispatches_start_in_creation_order() -> std::result::Result<(), Failure> {
    butler_e2e::gate!();
    let f = Fixture::open().await?;
    let mut running = f.service.delegate_worker(request("First")).await?;
    let mut waiting = Vec::new();
    for title in ["Second", "Third", "Fourth", "Fifth"] {
        waiting.push(f.service.delegate_worker(request(title)).await?);
    }
    f.storage
        .work_model_write(|tx| {
            tx.execute(
                "UPDATE wm_cross_db_intents SET created_at=100 WHERE kind='child_dispatch'",
                [],
            )?;
            Ok(())
        })
        .await?;
    for (index, next) in waiting.into_iter().enumerate() {
        f.finish(&running, "failed").await?;
        assert_eq!(
            f.queue.0.lock().unwrap()[index + 1],
            next["child_session_id"]
        );
        running = next;
    }
    f.close().await
}

// test-category: race
#[tokio::test]
async fn interrupted_child_recovers_without_waiting_workers_or_app()
-> std::result::Result<(), Failure> {
    butler_e2e::gate!();
    let f = Fixture::open().await?;
    let child = f.service.delegate_worker(request("Interrupted")).await?;
    let session = child["child_session_id"].as_str().unwrap().to_owned();
    let lookup = session.clone();
    let turn = f
        .storage
        .work_model_read(move |db| {
            Ok(db.query_row(
                "SELECT turn_id FROM wm_attempts WHERE session_id=?1",
                [lookup],
                |r| r.get::<_, String>(0),
            )?)
        })
        .await?;
    f.profiles.2.send_replace(false);
    tokio::time::timeout(std::time::Duration::from_secs(5), async {
        f.service
            .recover_native_assignments(vec![json!({"session_id":session,"turn_id":turn})])
            .await?;
        f.service.recover_waiting_workers().await
    })
    .await??;
    assert_eq!(f.counts().await?, (0, 0));
    assert!(f.service.child_turn_closed(&session, &turn).await?);
    let projection = f.service.app_projection("parent").await?;
    assert_eq!(
        projection["workers"][0]["result"]["status"], "failed",
        "{projection}"
    );
    assert_eq!(
        f.queue.0.lock().unwrap().len(),
        1,
        "no child was dispatched during recovery"
    );
    f.close().await
}
