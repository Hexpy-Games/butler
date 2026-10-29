use super::*;
#[tokio::test]
async fn composing_lease_holds_without_writes_or_events() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    let (s, address) = setup("SS2-COMPOSING", "2026-10-27T12:00:00.000Z").await?;
    let before = s.gw.events_since(0).await?;
    assert_eq!(
        s.gw.post("/sessions/general/composing", json!({}))
            .await?
            .status,
        200
    );
    assert_eq!(s.gw.events_since(0).await?, before);
    assert_eq!(
        s.gw.post("/sessions/missing/composing", json!({}))
            .await?
            .status,
        404
    );
    create(&s, "typing-report", "general", "2026-10-27T12:00:00.000Z").await?;
    s.gw.post("/automations/dispatch-due", json!({})).await?;
    assert_eq!(runs(&s, "typing-report").await?[0]["state"], "queued");
    assert_eq!(s.gw.messages("general").await?, [] as [Value; 0]);
    tokio::time::sleep(Duration::from_millis(200)).await;
    clock(&address, "2026-10-27T12:00:11.000Z").await?;
    let message = report(&s, "typing-report").await?;
    assert_eq!(message["text"], "Complete scheduled report.");
    s.finish().await
}
#[tokio::test]
async fn active_turn_and_queued_followup_precede_schedule() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    let (s, address) = setup("SS2-ORDER", "2026-10-27T12:00:00.000Z").await?;
    let held = s.provider()?.hold_next_reply("Wait for the report.");
    let first = s.gw.say_turn("general", "Wait for the report.").await?;
    s.gw.wait_turn(
        "general",
        &first,
        &["thinking", "streaming"],
        Duration::from_secs(30),
    )
    .await?;
    let followup = s.gw.post("/session-queue", json!({"chat_id":"general", "text":"Also include the latest totals.", "client_message_id":uuid::Uuid::new_v4().to_string()})).await?;
    assert_eq!(followup.status, 202, "{}", followup.text);
    create(&s, "ordered-report", "general", "2026-10-27T12:00:00.000Z").await?;
    s.gw.post("/automations/dispatch-due", json!({})).await?;
    assert_eq!(runs(&s, "ordered-report").await?[0]["state"], "queued");
    assert!(
        !s.gw
            .messages("general")
            .await?
            .iter()
            .any(|m| m["initiated"].is_object())
    );
    clock(&address, "2026-10-27T12:10:00.000Z").await?;
    held.release();
    let message = report(&s, "ordered-report").await?;
    let preceding: Vec<_> = s
        .gw
        .messages("general")
        .await?
        .into_iter()
        .filter(|m| m["role"] == "assistant" && m["cursor"].as_u64() < message["cursor"].as_u64())
        .collect();
    assert_eq!(preceding.len(), 2, "{preceding:?}");
    assert_eq!(runs(&s, "ordered-report").await?[0]["late"], true);
    s.finish().await
}
