//! Real-queue fault injection in a fixture-enabled agent.
use super::*;
use std::sync::atomic::Ordering;

#[tokio::test]
async fn cb_11_publish_failure_is_retryable_and_retry_starts_worker() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    publish_failure(true).await
}

#[tokio::test]
async fn cb_11_next_steward_turn_retries_failed_publish() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    publish_failure(false).await
}

async fn publish_failure(retry: bool) -> Result<(), HarnessError> {
    let (s, script, server) = setup("CB-11-PUBLISH-RETRY", 1).await?;
    s.patch_settings(json!({"max_simultaneous_workers":1}), "single Worker")
        .await?;
    script.hold_dispatch.store(true, Ordering::SeqCst);
    script.retry_same_turn.store(retry, Ordering::SeqCst);
    s.gw.say("general", "Verify batch red").await?;
    tokio::time::timeout(Duration::from_secs(30), script.dispatch_ready.wait())
        .await
        .unwrap();
    std::fs::write(
        s.sandbox
            .data
            .join("runtime/inbound-events/e2e-enqueue-fault.json"),
        br#"{"role":"worker"}"#,
    )?;
    script.dispatch_release.add_permits(1);
    let deadline = Instant::now() + Duration::from_secs(30);
    let output = loop {
        if let Some(output) = script.dispatch_output.lock().unwrap().clone() {
            break output;
        }
        assert!(Instant::now() < deadline, "{}", s.agent.logs());
        tokio::time::sleep(Duration::from_millis(20)).await;
    };
    assert_eq!(output["output"]["ok"], false, "{output}");
    assert_eq!(output["output"]["error"]["code"], "worker_start_failed");
    assert_eq!(
        output["output"]["error"]["message"],
        "Couldn't start the Worker; call it again."
    );
    assert_eq!(output["output"]["error"]["recoverable"], true);
    assert!(output["output"]["status"].is_null());
    let (parent, _) = workers(&s, "general", 1).await?;
    let db = rusqlite::Connection::open(s.sandbox.data.join("agent-runtime/btcc.sqlite"))?;
    let running: u64 = db.query_row(
        butler_turn::btcc::storage::RUNNING_WORKERS_SQL,
        [parent],
        |r| r.get(0),
    )?;
    assert_eq!(running, 0);
    drop(db);
    assert!(script.started.lock().unwrap().is_empty());
    let blue = if retry {
        script.hold_dispatch.store(false, Ordering::SeqCst);
        let created = s.gw.post("/sessions", json!({"kind":"chat"})).await?;
        let chat = created.data()["session"]["id"].as_str().unwrap().to_owned();
        s.gw.say(&chat, "Verify batch blue").await?;
        let (_, rows) = workers(&s, &chat, 1).await?;
        started(&script, 1).await;
        assert_eq!(*script.started.lock().unwrap(), ["blue-0"]);
        Some(rows[0]["session_id"].as_str().unwrap().to_owned())
    } else {
        None
    };
    script.retry_release.add_permits(1);
    if !retry {
        let (parent, _) = workers(&s, "general", 1).await?;
        next_steward_turn(&s, &parent).await?;
    }
    started(&script, if retry { 2 } else { 1 }).await;
    let (_, rows) = workers(&s, "general", 1).await?;
    script.release("red-0");
    closed(&s, rows[0]["session_id"].as_str().unwrap()).await?;
    if let Some(blue) = blue {
        script.release("blue-0");
        closed(&s, &blue).await?;
    }
    s.finish().await?;
    server.abort();
    Ok(())
}

async fn next_steward_turn(s: &Scenario, parent: &str) -> Result<(), HarnessError> {
    let deadline = Instant::now() + Duration::from_secs(30);
    loop {
        let db = rusqlite::Connection::open(s.sandbox.data.join("agent-runtime/btcc.sqlite"))?;
        let failed: bool = db.query_row("SELECT EXISTS(SELECT 1 FROM btcc_steward_results WHERE child_session_id=?1 AND status='failed')", [parent], |r| r.get(0))?;
        if failed {
            break;
        }
        assert!(Instant::now() < deadline, "{}", s.agent.logs());
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
    let db = rusqlite::Connection::open(s.sandbox.data.join("agent-runtime/btcc.sqlite"))?;
    let raw: String = db.query_row("SELECT d.dispatch_intent_json FROM btcc_subsession_delegations d JOIN btcc_session_relations r USING(relation_id) WHERE r.child_session_id=?1", [parent], |r| r.get(0))?;
    let mut envelope = serde_json::from_str::<Value>(&raw)?["envelope"].clone();
    let id = format!("next-turn-{}", uuid::Uuid::new_v4());
    envelope["eventId"] = json!(id);
    envelope["message"]["id"] = json!(id);
    envelope["message"]["text"] = json!("Retry pending Workers");
    envelope["routingHints"]["turnId"] = json!(id);
    let document = butler_core::json::JsonDocument::from_value(&envelope).unwrap();
    let data = s.sandbox.data.clone();
    tokio::task::spawn_blocking(move || {
        butler_gateway::gateway::InboundQueue::new(&data).enqueue_idempotent(document)
    })
    .await
    .unwrap()
    .map_err(|e| butler_e2e::e2e::harness_error(e.to_string()))?;
    Ok(())
}
