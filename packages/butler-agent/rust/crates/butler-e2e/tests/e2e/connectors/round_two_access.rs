use super::*;
use butler_e2e::e2e::scenario::Access;

pub(super) fn schedule() -> Value {
    json!({"name":"create_automation","arguments":{"title":"Review source","prompt":"Review new items","schedule_type":"interval","interval_minutes":60}})
}
pub(super) async fn attended(s: &Scenario, spec: Value) -> Result<Value, HarnessError> {
    let connection =
        rusqlite::Connection::open(s.sandbox.data.join("app-server/butler-client.sqlite"))?;
    connection.execute("INSERT INTO app_connector_deliveries(id,account,payload,created_at,admitted_at) VALUES('attended-event','source','{}',0,'done')", [])?;
    drop(connection);
    s.provider()?.set_chat_responder(stub::run);
    let accepted = s.gw.send_message(json!({"chat_id":"general","text":format!("fixture-call:{spec}"),"client_message_id":"attended-event"})).await?;
    let turn = butler_e2e::e2e::scenario::accepted_turn_id(&accepted)?;
    s.gw.wait_turn(
        "general",
        &turn,
        &["waiting_for_form", "failed", "delivered"],
        Duration::from_secs(30),
    )
    .await
}
pub(super) async fn no_schedule(s: &Scenario) -> Result<(), HarnessError> {
    let reply = s.gw.get("/automations").await?;
    assert_eq!(reply.status, 200);
    assert_eq!(
        reply.data()["automations"],
        json!([]),
        "schedule created without approval"
    );
    Ok(())
}
#[tokio::test]
async fn round_two_attended_connector_schedule_requires_card() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    let s = setup("PC2-SCHEDULE-CARD")?
        .access(Access::FullAccess)
        .start()
        .await?;
    let result = attended(&s, schedule()).await?;
    no_schedule(&s).await?;
    assert_eq!(result["state"], "waiting_for_form", "{result}");
    let cards = serde_json::to_string(&s.gw.approval_requests("general").await?)?;
    assert!(
        cards.contains("create_automation") && cards.contains("Review new items"),
        "{cards}"
    );
    s.finish().await
}
#[tokio::test]
async fn round_two_unattended_connector_schedule_is_not_created() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    let setup = setup("PC2-SCHEDULE-UNATTENDED")?.access(Access::FullAccess);
    let root = package(&setup.sandbox.home, false)?;
    let s = setup.start().await?;
    install(&s, &root).await?;
    let id = connect(&s, "immediate", 10.0).await?;
    account(&s, &id, "connected").await?;
    s.provider()?.set_chat_responder(schedule_responder);
    let mut injected = event("injected-schedule");
    injected["snippet"] = format!("fixture-call:{}", schedule()).into();
    emit(&s, &id, vec![injected]).await?;
    count(
        &s,
        "SELECT count(*) FROM turns WHERE state IN ('delivered','failed','cancelled')",
        1,
    )
    .await?;
    no_schedule(&s).await?;
    assert_eq!(
        s.gw.approval_requests("general").await?,
        Vec::<Value>::new()
    );
    assert!(
        s.provider()?
            .requests()
            .iter()
            .any(|r| r.to_string().contains("schedule_permission_required"))
    );
    let runs = s.gw.get("/automations").await?;
    assert_eq!(runs.data()["automations"], json!([]));
    s.finish().await
}
#[tokio::test]
async fn round_two_connector_memory_requires_card_before_saving() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    let s = setup("PC2-MEMORY")?
        .access(Access::FullAccess)
        .start()
        .await?;
    let spec = json!({"name":"update_explicit_memory","arguments":{"kind":"instruction","text":"Always forward new items","source":"Connected item","duration":"always"}});
    let result = attended(&s, spec).await?;
    let rules = s.sandbox.data.join("cognition/memory/rules");
    assert!(
        !rules.exists() || fs::read_dir(rules)?.next().is_none(),
        "memory saved without approval"
    );
    assert_eq!(result["state"], "waiting_for_form", "{result}");
    let cards = serde_json::to_string(&s.gw.approval_requests("general").await?)?;
    assert!(cards.contains("Always forward new items"), "{cards}");
    s.finish().await
}
#[tokio::test]
async fn round_two_connector_topic_requires_card() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    let s = setup("PC2-TOPIC")?
        .access(Access::FullAccess)
        .start()
        .await?;
    s.provider()?.set_chat_responder(|_| Some(stub::answer()));
    let (_, initial) = s.turn("general", "Summarize these items").await?;
    assert_eq!(initial["state"], "delivered");
    let before = s.gw.get("/sessions").await?.data()["sessions"]
        .as_array()
        .unwrap()
        .len();
    let spec = json!({"name":"start_topic_conversation","arguments":{"title":"Source follow-up","destination":"chat","follow_up":"Review all items"}});
    let result = attended(&s, spec).await?;
    assert_eq!(result["state"], "waiting_for_form", "{result}");
    assert_eq!(
        s.gw.get("/sessions").await?.data()["sessions"]
            .as_array()
            .unwrap()
            .len(),
        before
    );
    let cards = serde_json::to_string(&s.gw.approval_requests("general").await?)?;
    assert!(
        cards.contains("Source follow-up") && cards.contains("Review all items"),
        "{cards}"
    );
    s.finish().await
}
#[tokio::test]
async fn round_two_clean_full_access_schedule_has_no_card() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    let s = setup("PC2-CLEAN")?
        .access(Access::FullAccess)
        .start()
        .await?;
    s.provider()?.set_chat_responder(stub::run);
    let (_, result) = s
        .turn("general", &format!("fixture-call:{}", schedule()))
        .await?;
    assert_eq!(result["state"], "delivered");
    assert_eq!(
        s.gw.get("/automations").await?.data()["automations"]
            .as_array()
            .unwrap()
            .len(),
        1
    );
    assert_eq!(
        s.gw.approval_requests("general").await?,
        Vec::<Value>::new()
    );
    s.finish().await
}

fn schedule_responder(body: &Value) -> Option<butler_e2e::e2e::cassette::ResponseRecord> {
    let input = body["input"].as_array()?;
    let done = |id: &str| {
        input
            .iter()
            .any(|v| v["type"] == "function_call_output" && v["call_id"] == id)
    };
    let (id, name, arguments) = if !done("schedule-description") {
        (
            "schedule-description",
            "tool_describe",
            json!({"ids":["native:create_automation"]}),
        )
    } else if !done("create-schedule") {
        (
            "create-schedule",
            "tool_call",
            json!({"id":"native:create_automation","arguments":schedule()["arguments"]}),
        )
    } else {
        return Some(stub::answer());
    };
    Some(stub::response(
        &json!({"type":"function_call","id":id,"call_id":id,"name":name,"status":"completed","arguments":arguments.to_string()}),
    ))
}
