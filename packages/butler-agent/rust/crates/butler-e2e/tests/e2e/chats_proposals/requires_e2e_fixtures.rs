use super::*;
#[tokio::test]
async fn ss3_bundle_accept_decline_events_and_restart() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    let mut s = patterns::setup("SS3-PROPOSAL").await?;
    s.provider()?.set_chat_responder(responder);
    assert_eq!(
        s.gw.patch("/settings", json!({"timezone":"Asia/Seoul"}))
            .await?
            .status,
        200
    );
    patterns::seed(&s, 0, 8)?;
    patterns::enable(&s).await?;
    let store = patterns::run(&s).await?;
    let row = proposal(&s).await?;
    assert_eq!(row["text"], "Want me to get these ready before you ask?");
    let panel = &row["initiated"]["panel"];
    assert_eq!(panel["candidates"].as_array().unwrap().len(), 2);
    assert!(panel["candidates"][0]["action"]["prompt"].is_null());
    let path = format!(
        "/memory/pattern-proposals/{}",
        panel["bundle_id"].as_str().unwrap()
    );
    let accepted = s.gw.post(&path,json!({"pattern_id":panel["candidates"][0]["pattern_id"],"decision":"accepted","expected_revision":store["revision"]})).await?;
    assert_eq!(accepted.status, 200, "{}", accepted.text);
    let id = accepted.data()["automation_id"].as_str().unwrap();
    let automation = s.gw.get(&format!("/automations/{id}")).await?.data()["automation"].clone();
    assert_eq!(automation["target_session_id"], "general");
    assert_eq!(automation["schedule"]["kind"], "daily");
    assert_eq!(automation["schedule"]["time"], "07:50");
    assert_eq!(automation["schedule"]["tz"], "Asia/Seoul");
    assert_eq!(automation["next_run_at"], "2026-10-26T22:50:00.000Z");
    let revision = s.gw.get("/memory/pattern-proposals").await?.data()["revision"].clone();
    let declined = s.gw.post(&path,json!({"pattern_id":panel["candidates"][1]["pattern_id"],"decision":"declined","expected_revision":revision})).await?;
    assert_eq!(declined.status, 200, "{}", declined.text);
    let updated = proposal(&s).await?;
    assert_eq!(
        updated["initiated"]["panel"]["candidates"][0]["automation_id"],
        id
    );
    assert_eq!(
        updated["initiated"]["panel"]["candidates"][1]["state"],
        "declined"
    );
    let events = s.gw.events_since(0).await?;
    assert!(
        !events
            .iter()
            .any(|e| e["type"].as_str().unwrap_or("").starts_with("authority."))
    );
    assert_eq!(
        s.gw.get("/authority-requests?session_id=general")
            .await?
            .data()["requests"],
        json!([])
    );
    assert_eq!(events.iter().filter(|e| e["type"]=="message.updated" && e["payload"]["message"]["id"]==row["id"]).count(),2);
    patterns::seed(&s, 8, 4)?;
    let after = patterns::run(&s).await?;
    assert_eq!(
        after["removed"][0]["id"],
        panel["candidates"][1]["pattern_id"]
    );
    assert_eq!(messages(&s).await?.len(), 1);
    s.restart().await?;
    assert_eq!(messages(&s).await?.len(), 1);
    s.finish().await
}

#[tokio::test]
async fn quiet_proposal_waits_until_morning_without_another_trigger() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    let (s, address) =
        crate::chats_initiated::support::setup("SS3-QUIET", "2026-10-27T06:59:59.000Z").await?;
    s.provider()?.set_chat_responder(responder);
    patterns::seed(&s, 0, 8)?;
    patterns::enable(&s).await?;
    let store = patterns::run(&s).await?;
    assert_eq!(store["bundles"].as_array().unwrap().len(), 1);
    assert_eq!(messages(&s).await?, [] as [Value; 0]);
    tokio::time::sleep(Duration::from_millis(200)).await;
    crate::chats_initiated::support::clock(&address, "2026-10-27T07:00:00.000Z").await?;
    let row = proposal(&s).await?;
    assert_eq!(row["initiated"]["quiet"], false);
    assert_eq!(
        row["initiated"]["panel"]["candidates"]
            .as_array()
            .unwrap()
            .len(),
        2
    );
    s.finish().await
}

#[tokio::test]
async fn queued_proposal_and_report_follow_the_active_turn_and_followup() -> Result<(), HarnessError>
{
    butler_e2e::gate!();
    let (s, address) =
        crate::chats_initiated::support::setup("SS3-ORDER", "2026-10-27T12:00:00.000Z").await?;
    s.provider()?.set_chat_responder(responder);
    assert_eq!(
        s.gw.post("/sessions/general/composing", json!({}))
            .await?
            .status,
        200
    );
    patterns::seed(&s, 0, 8)?;
    patterns::enable(&s).await?;
    patterns::run(&s).await?;
    assert_eq!(messages(&s).await?, [] as [Value; 0]);
    let held = s.provider()?.hold_next_reply("Prepare the current answer.");
    let first = butler_e2e::e2e::scenario::accepted_turn_id(
        &s.gw.say("general", "Prepare the current answer.").await?,
    )?;
    s.gw.wait_turn(
        "general",
        &first,
        &["thinking", "streaming"],
        Duration::from_secs(30),
    )
    .await?;
    let followup = s.gw.post("/session-queue", json!({"chat_id":"general", "text":"Include the latest totals.", "client_message_id":uuid::Uuid::new_v4().to_string()})).await?;
    assert_eq!(followup.status, 202, "{}", followup.text);
    crate::chats_initiated::support::create(
        &s,
        "proposal-order-report",
        "general",
        "2026-10-27T12:00:00.000Z",
    )
    .await?;
    s.gw.post("/automations/dispatch-due", json!({})).await?;
    assert_eq!(
        crate::chats_initiated::support::runs(&s, "proposal-order-report").await?[0]["state"],
        "queued"
    );
    crate::chats_initiated::support::clock(&address, "2026-10-27T12:00:11.000Z").await?;
    assert_eq!(messages(&s).await?, [] as [Value; 0]);
    held.release();
    let report = crate::chats_initiated::support::report(&s, "proposal-order-report").await?;
    let proposal = proposal(&s).await?;
    let replies: Vec<_> =
        s.gw.messages("general")
            .await?
            .into_iter()
            .filter(|m| m["role"] == "assistant" && m["initiated"].is_null())
            .collect();
    assert_eq!(replies.len(), 2, "{replies:?}");
    for reply in replies {
        assert!(reply["cursor"].as_u64() < report["cursor"].as_u64());
        assert!(reply["cursor"].as_u64() < proposal["cursor"].as_u64());
    }
    s.finish().await
}
