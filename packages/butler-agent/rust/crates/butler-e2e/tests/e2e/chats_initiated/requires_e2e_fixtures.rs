use super::*;
#[path = "ordering.rs"]
mod ordering;
#[path = "pause.rs"]
mod pause;
#[tokio::test]
async fn ss2_schedule_origin_hides_only_the_general_prompt() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    let (s, _) = setup("SS2-REPORT", "2026-10-27T12:00:00.000Z").await?;
    create(&s, "general-report", "general", "2026-10-28T12:00:00.000Z").await?;
    let r =
        s.gw.post("/automations/general-report/run", json!({}))
            .await?;
    assert_eq!(r.status, 202, "{}", r.text);
    let message = report(&s, "general-report").await?;
    let turn = &message["turn_id"];
    assert_eq!(
        message["initiated"],
        json!({"kind":"schedule_report","quiet":false,"automation_id":"general-report","automation_title":"Daily report"})
    );
    assert!(
        !s.gw
            .messages("general")
            .await?
            .iter()
            .any(|m| m["turn_id"] == *turn && m["role"] == "user")
    );
    let navigation = s.gw.get("/navigation").await?;
    assert_eq!(
        navigation.data()["chats"]
            .as_array()
            .unwrap()
            .iter()
            .find(|c| c["id"] == "general")
            .unwrap()["unread"],
        true
    );
    assert_eq!(
        s.gw.post("/sessions/general/read", json!({})).await?.data()["changed"],
        true
    );
    let navigation = s.gw.get("/navigation").await?;
    assert_eq!(
        navigation.data()["chats"]
            .as_array()
            .unwrap()
            .iter()
            .find(|c| c["id"] == "general")
            .unwrap()["unread"],
        false
    );
    let events = s.gw.events_since(0).await?;
    assert!(!events.iter().any(|e| e["type"] == "message.created"
        && e["payload"]["message"]["turn_id"] == *turn
        && e["payload"]["message"]["role"] == "user"));
    assert!(events.iter().any(|e| (e["type"] == "message.created"
        || e["type"] == "message.updated")
        && e["payload"]["message"]["id"] == message["id"]
        && e["payload"]["message"]["initiated"]["kind"] == "schedule_report"));
    let session =
        s.gw.post("/sessions", json!({"kind":"chat","title":"Other"}))
            .await?;
    let chat = session.data()["session"]["id"].as_str().unwrap();
    create(&s, "other-report", chat, "2026-10-28T12:00:00.000Z").await?;
    let r =
        s.gw.post("/automations/other-report/run", json!({}))
            .await?;
    let turn = r.data()["run"]["turn_id"].as_str().unwrap();
    s.gw.wait_terminal(chat, turn, Duration::from_secs(90))
        .await?;
    assert!(
        s.gw.messages(chat)
            .await?
            .iter()
            .any(|m| m["turn_id"] == turn && m["role"] == "user")
    );
    s.finish().await
}

#[tokio::test]
async fn quiet_hours_queue_then_release_without_a_new_request() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    let (s, address) = setup("SS2-QUIET", "2026-10-27T06:59:59.000Z").await?;
    create(&s, "quiet-report", "general", "2026-10-27T06:59:59.000Z").await?;
    let r = s.gw.post("/automations/dispatch-due", json!({})).await?;
    assert_eq!(r.status, 202, "{}", r.text);
    assert_eq!(runs(&s, "quiet-report").await?[0]["state"], "queued");
    assert_eq!(s.gw.messages("general").await?, [] as [Value; 0]);
    create(&s, "manual-report", "general", "2026-10-28T12:00:00.000Z").await?;
    s.gw.post("/sessions/general/composing", json!({})).await?;
    let manual =
        s.gw.post("/automations/manual-report/run", json!({}))
            .await?;
    assert_eq!(manual.data()["run"]["state"], "succeeded");
    let turn = manual.data()["run"]["turn_id"].as_str().unwrap();
    s.gw.wait_terminal("general", turn, Duration::from_secs(90))
        .await?;
    assert_eq!(runs(&s, "quiet-report").await?[0]["state"], "queued");
    // Let the enqueue notifications settle before changing the clock.
    tokio::time::sleep(Duration::from_millis(200)).await;
    let start = Instant::now();
    clock(&address, "2026-10-27T07:00:10.000Z").await?;
    let message = report(&s, "quiet-report").await?;
    eprintln!("SS2 quiet_release_ms={}", start.elapsed().as_millis());
    assert_eq!(message["text"], "Complete scheduled report.");
    let records = runs(&s, "quiet-report").await?;
    assert_eq!(records.len(), 1);
    assert_eq!(records[0]["scheduled_at"], "2026-10-27T06:59:59.000Z");
    assert_eq!(records[0]["late"], false);
    s.finish().await
}
