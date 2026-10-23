//! Pending admission survives a process exit before slot release.
use super::*;

#[tokio::test]
async fn cb_11_pending_worker_starts_after_restart() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    let (mut s, script, server) = setup("CB-11-RESTART", 4).await?;
    s.gw.say("general", "Verify batch red").await?;
    let (_, rows) = workers(&s, "general", 3).await?;
    started(&script, 2).await;
    assert_eq!(rows[2]["status"], "waiting");
    // Exit before active turns can release slots during the shutdown drain.
    s.agent.kill9()?;
    let db = rusqlite::Connection::open(s.sandbox.data.join("agent-runtime/btcc.sqlite"))?;
    let pending: String = db.query_row(
        "SELECT dispatch_state FROM btcc_subsession_delegations WHERE relation_id=?1",
        [rows[2]["relation"]["relation_id"].as_str().unwrap()],
        |r| r.get(0),
    )?;
    assert_eq!(pending, "pending");
    drop(db);
    s.gw = s.agent.start_again().await?;
    started(&script, 3).await;
    script.release("red-2");
    closed(&s, rows[2]["session_id"].as_str().unwrap()).await?;
    s.finish().await?;
    server.abort();
    Ok(())
}

#[tokio::test]
async fn cb_11_settings_increase_admits_waiting_without_a_completion() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    let (s, script, server) = setup("CB-11-SETTINGS", 4).await?;
    s.gw.say("general", "Verify batch red").await?;
    let (_, rows) = workers(&s, "general", 3).await?;
    started(&script, 2).await;
    assert_eq!(rows[2]["status"], "waiting");
    s.patch_settings(json!({"max_simultaneous_workers":3}), "raise cap")
        .await?;
    started(&script, 3).await;
    for key in ["red-0", "red-1", "red-2"] {
        script.release(key);
    }
    script.fourth.add_permits(1);
    started(&script, 4).await;
    script.release("red-3");
    let (_, rows) = workers(&s, "general", 4).await?;
    closed(&s, rows[3]["session_id"].as_str().unwrap()).await?;
    s.finish().await?;
    server.abort();
    Ok(())
}

#[tokio::test]
async fn cb_11_cancel_with_waiting_direction_recovers_after_restart() -> Result<(), HarnessError> {
    use std::sync::atomic::Ordering;
    butler_e2e::gate!();
    let (mut s, script, server) = setup("CB-11-CANCEL-DIRECTION", 4).await?;
    script.steer.store(true, Ordering::SeqCst);
    s.gw.say("general", "Verify batch red").await?;
    let (_, rows) = workers(&s, "general", 3).await?;
    started(&script, 2).await;
    let deadline = Instant::now() + Duration::from_secs(30);
    while !script.steered.load(Ordering::SeqCst) {
        assert!(Instant::now() < deadline, "{}", s.agent.logs());
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
    assert_pending_direction(&s, &rows[2])?;
    script.release("red-0");
    started(&script, 3).await;
    s.patch_settings(json!({"max_simultaneous_workers":1}), "lower cap")
        .await?;
    script.fourth.add_permits(1);
    let (_, rows) = workers(&s, "general", 4).await?;
    let turn = rows[2]["active_turn"]["id"].as_str().unwrap();
    cancel_worker(&s, &rows[2]).await?;
    let deadline = Instant::now() + Duration::from_secs(30);
    loop {
        let db = rusqlite::Connection::open(s.sandbox.data.join("agent-runtime/btcc.sqlite"))?;
        let cancelled: bool = db.query_row("SELECT EXISTS(SELECT 1 FROM btcc_steward_results WHERE child_turn_id=?1 AND status='cancelled')", [turn], |r| r.get(0))?;
        if cancelled {
            break;
        }
        assert!(Instant::now() < deadline, "{}", s.agent.logs());
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
    assert!(!script.continued.is_open());
    s.agent.kill9()?;
    s.gw = s.agent.start_again().await?;
    tokio::time::timeout(Duration::from_secs(30), script.continued.wait())
        .await
        .unwrap();
    started(&script, 4).await;
    script.release("red-1");
    script.release("red-2");
    script.release("red-3");
    closed(&s, rows[3]["session_id"].as_str().unwrap()).await?;
    s.finish().await?;
    server.abort();
    Ok(())
}

// App turn controls address chat turns; child cancellation enters through the
// same durable native control queue used by the subsession service.
pub(crate) async fn cancel_worker(s: &Scenario, child: &Value) -> Result<(), HarnessError> {
    use butler_core::json::JsonDocument;
    use butler_e2e::e2e::harness_error;
    use butler_gateway::gateway::InboundQueue;
    let relation = &child["relation"];
    let turn = child["active_turn"]["id"].as_str().unwrap();
    let id = format!("cancel-{}", uuid::Uuid::new_v4());
    let now = chrono::Utc::now().to_rfc3339();
    let envelope =
        JsonDocument::from_value(&json!({"eventId":id,"transport":"app","accountId":"local",
        "peer":{"kind":"dm","id":child["session_id"],"parentId":relation["parent_session_id"]},
        "sender":{"id":"subsession-parent-cancel","displayName":"Parent"},
        "message":{"id":id,"text":"","timestamp":now},
        "routingHints":{"sessionId":child["session_id"],"turnId":turn},
        "control":{"kind":"cancel_turn","requestId":id,"turnId":turn,"requestedAt":now}}))
        .map_err(|e| harness_error(e.to_string()))?;
    let metadata = serde_json::Map::from_iter([
        ("source".into(), json!("btcc-steward-control")),
        ("relation_id".into(), relation["relation_id"].clone()),
        (
            "source_parent_turn_id".into(),
            relation["parent_turn_id"].clone(),
        ),
    ]);
    let data = s.sandbox.data.clone();
    tokio::task::spawn_blocking(move || {
        InboundQueue::new(&data).enqueue_idempotent_with_metadata(envelope, metadata)
    })
    .await
    .map_err(|e| harness_error(e.to_string()))?
    .map_err(|e| harness_error(e.to_string()))?;
    Ok(())
}
