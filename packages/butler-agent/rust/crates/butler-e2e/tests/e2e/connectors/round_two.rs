use super::*;

#[tokio::test]
async fn round_two_returned_signal_preserves_original_in_batch_window() -> Result<(), HarnessError>
{
    butler_e2e::gate!();
    let setup = setup("PC2-RETURNED")?;
    let root = package(&setup.sandbox.home, false)?;
    let s = setup.start().await?;
    s.provider()?.set_chat_responder(|_| Some(stub::answer()));
    install(&s, &root).await?;
    let id = connect(&s, "batch", 0.1).await?;
    account(&s, &id, "connected").await?;
    emit(&s, &id, vec![event("original")]).await?;
    count(
        &s,
        "SELECT count(*) FROM app_connector_events WHERE ready=1 AND delivered_at IS NULL",
        1,
    )
    .await?;
    let mut signal = event("returned");
    signal["dedupe_key"] = "original".into();
    signal["signal"] = json!({"type":"returned","ref":"original"});
    emit(&s, &id, vec![signal.clone()]).await?;
    count(&s, "SELECT count(*) FROM app_connector_signals", 1).await?;
    let (delivered, digested): (Option<String>, Option<String>) = db(&s).query_row(
        "SELECT delivered_at,digested_at FROM app_connector_events WHERE dedupe_key='original'",
        [],
        |r| Ok((r.get(0)?, r.get(1)?)),
    )?;
    assert!(
        delivered.is_none() && digested.is_none(),
        "signal consumed original inside batch window"
    );
    count(
        &s,
        "SELECT count(*) FROM app_connector_events WHERE delivered_at IS NOT NULL",
        1,
    )
    .await?;
    emit(&s, &id, vec![signal, event("original")]).await?;
    count(&s, "SELECT count(*) FROM app_connector_cursors", 1).await?;
    let payloads: Vec<String> = db(&s)
        .prepare("SELECT payload FROM app_connector_deliveries")?
        .query_map([], |r| r.get(0))?
        .collect::<Result<_, _>>()?;
    let payloads = payloads
        .iter()
        .map(|p| serde_json::from_str::<Value>(p))
        .collect::<Result<Vec<_>, _>>()?;
    let events = payloads
        .iter()
        .flat_map(|p| p["events"].as_array().unwrap())
        .collect::<Vec<_>>();
    assert_eq!(events.len(), 1);
    assert_eq!(events[0]["id"], "original");
    count(&s, "SELECT count(*) FROM turns WHERE state='delivered'", 1).await?;
    assert!(
        s.provider()?.requests().iter().any(|request| {
            let text = request.to_string();
            text.contains("<connector-data>") && text.contains("original")
        }),
        "the original event must reach the model"
    );
    s.finish().await
}
