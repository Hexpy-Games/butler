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
