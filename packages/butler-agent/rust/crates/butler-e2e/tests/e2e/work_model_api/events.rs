use super::*;

#[tokio::test]
async fn canon_events_replay_after_restart_without_duplicates() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    let mut s = Setup::new("WMA-EVENT-REPLAY")?.start().await?;
    let project = project(&s).await?;
    let stream = LiveEvents::subscribe(&s.gw, 0).await?;
    let plan = create_plan(&s, &project, "Plan").await?;
    let id = plan["id"].as_str().unwrap();
    let original = event(&stream, "canon.changed", id).await?;
    drop(stream);
    s.restart().await?;
    let stream = LiveEvents::subscribe(&s.gw, 0).await?;
    assert_eq!(event(&stream, "canon.changed", id).await?, original);
    let updated = data(
        s.gw.patch(
            &format!("/canon/plans/{id}"),
            json!({"expected_revision":plan["revision"],"title":"Updated plan"}),
        )
        .await?,
        200,
    );
    let changed = stream
        .wait_for(Duration::from_secs(10), |e| {
            e["type"] == "canon.changed"
                && e["payload"]["id"] == id
                && e["payload"]["revision"] == updated["revision"]
        })
        .await?;
    assert!(changed["id"].as_u64() > original["id"].as_u64());
    // The updated event is a stream barrier: replay before it must contain
    // exactly one copy of the original committed event.
    let replay = LiveEvents::subscribe(&s.gw, original["id"].as_u64().unwrap()).await?;
    assert_eq!(event(&replay, "canon.changed", id).await?, changed);
    drop(replay);
    drop(stream);
    s.finish().await
}

// Exercise a runtime-only mutation on the real writer lane while stopped,
// then observe its durable event through the live App stream after restart.
pub(super) async fn review_task_and_observe(
    s: &mut Scenario,
    chat: &str,
    before: &Value,
    barrier: &Value,
) -> Result<(), HarnessError> {
    s.agent.terminate().await?;
    let output =
        tokio::process::Command::new(butler_e2e::e2e::binary::fixture_binary("e2e-work-store")?)
            .kill_on_drop(true)
            .arg(s.sandbox.data.join("agent-runtime/btcc.sqlite"))
            .args(["tk_schema", "in_review"])
            .output()
            .await?;
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    s.restart().await?;
    let stream = LiveEvents::subscribe(&s.gw, barrier["id"].as_u64().unwrap()).await?;
    let changed = event(&stream, "work_model.changed", "wk_canon").await?;
    assert_eq!(
        changed["payload"],
        json!({"scope":"tasks","work_id":"wk_canon",
        "session_id":chat,"task_graph_revision":before["task_graph_revision"]})
    );
    let after = queue(s, "wk_canon").await?;
    assert_eq!(after["task_graph_revision"], before["task_graph_revision"]);
    assert_eq!(
        after["chains"][0]["steps"][0]["tasks"][0]["status"],
        "in_review"
    );
    drop(stream);
    Ok(())
}
