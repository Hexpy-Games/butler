//! Interrupted assignments close their queued Workers on restart.
use super::*;

#[tokio::test]
async fn cb_11_pending_workers_close_with_interrupted_parent_after_restart()
-> Result<(), HarnessError> {
    butler_e2e::gate!();
    let (mut s, script, server) = setup("CB-11-RESTART", 4).await?;
    s.gw.say("general", "Verify batch red").await?;
    workers(&s, "general", 3).await?;
    started(&script, 2).await;
    script.fourth.add_permits(1);
    let (steward, rows) = workers(&s, "general", 4).await?;
    // Exit before active turns can release slots during the shutdown drain.
    s.agent.kill9()?;
    let db = rusqlite::Connection::open(s.sandbox.data.join("agent-runtime/btcc.sqlite"))?;
    let pending: String = db.query_row(
        "SELECT dispatch_state FROM btcc_subsession_delegations WHERE relation_id=?1",
        [rows[2]["relation"]["relation_id"].as_str().unwrap()],
        |r| r.get(0),
    )?;
    assert_eq!(pending, "pending");
    db.execute("UPDATE btcc_subsession_delegations SET created_at='2026-10-24T00:00:00.000Z' WHERE relation_id IN (?1,?2)", rusqlite::params![rows[2]["relation"]["relation_id"].as_str().unwrap(), rows[3]["relation"]["relation_id"].as_str().unwrap()])?;
    let next: String = db.query_row(
        butler_turn::btcc::storage::WAITING_WORKERS_SQL,
        [rows[2]["relation"]["parent_session_id"].as_str().unwrap()],
        |r| r.get(0),
    )?;
    assert_eq!(next, rows[2]["relation"]["relation_id"]);
    drop(db);
    s.gw = s.agent.start_again().await?;
    let deadline = Instant::now() + Duration::from_secs(30);
    loop {
        let view = s.gw.get("/session-view?session_id=general").await?;
        let parent = &view.data()["steward_children"][0];
        if parent["terminal"] == true {
            assert_eq!(parent["result"]["status"], "failed", "{parent}");
            break;
        }
        assert!(Instant::now() < deadline, "{view:?}\n{}", s.agent.logs());
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
    let db = rusqlite::Connection::open(s.sandbox.data.join("agent-runtime/btcc.sqlite"))?;
    for row in &rows[2..] {
        let (results, cancelled, pending): (i64, i64, bool) = db.query_row(
            "SELECT count(*),sum(x.status='cancelled'),d.dispatch_state IS NOT NULL
             FROM btcc_steward_results x JOIN btcc_subsession_delegations d USING(relation_id)
             WHERE x.relation_id=?1",
            [row["relation"]["relation_id"].as_str().unwrap()],
            |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
        )?;
        assert_eq!((results, cancelled, pending), (1, 1, false));
    }
    for session in std::iter::once(steward.as_str())
        .chain(rows.iter().map(|row| row["session_id"].as_str().unwrap()))
    {
        assert!(butler_turn::btcc::storage::terminal_card_invariant(&db, session).unwrap());
    }
    assert_eq!(*script.started.lock().unwrap(), ["red-0", "red-1"]);
    drop(db);
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
async fn cb_11_cancel_before_first_run_through_queue() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    let (mut s, script, server) = setup("CB-11-CANCEL-WAITING", 4).await?;
    s.gw.say("general", "Verify batch red").await?;
    let (parent, rows) = workers(&s, "general", 3).await?;
    started(&script, 2).await;
    assert_eq!(rows[2]["status"], "waiting");
    let relation = rows[2]["relation"]["relation_id"].as_str().unwrap();
    let cancelled =
        s.gw.post(
            &format!("/steward-relations/{relation}/cancel"),
            json!({"parent_session_id":parent}),
        )
        .await?;
    assert_eq!(cancelled.status, 202, "{cancelled:?}");
    let deadline = Instant::now() + Duration::from_secs(30);
    loop {
        let db = rusqlite::Connection::open(s.sandbox.data.join("agent-runtime/btcc.sqlite"))?;
        let saved: bool = db.query_row("SELECT EXISTS(SELECT 1 FROM btcc_steward_results WHERE relation_id=?1 AND status='cancelled')", [relation], |r| r.get(0))?;
        if saved {
            break;
        }
        assert!(Instant::now() < deadline, "{}", s.agent.logs());
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
    script.fourth.add_permits(1);
    script.release("red-0");
    started(&script, 3).await;
    assert_eq!(*script.started.lock().unwrap(), ["red-0", "red-1", "red-3"]);
    script.release("red-1");
    script.release("red-3");
    let (_, all) = workers(&s, "general", 4).await?;
    closed(&s, all[3]["session_id"].as_str().unwrap()).await?;
    s.agent.kill9()?;
    s.gw = s.agent.start_again().await?;
    assert!(
        !script
            .started
            .lock()
            .unwrap()
            .iter()
            .any(|key| key == "red-2")
    );
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
