use super::*;
fn rule() -> Value {
    json!({"id":"updates","connector":"source/items","title":"Organize updates","reason":"User preference","match":[{"field":"attributes.list-id","op":"equals","value":"UPDATES.EXAMPLE.TEST"}],"actions":[{"type":"organize","tool":"events/move","arguments":{"destination":"keep"}},{"type":"organize","tool":"events/mark_read","arguments":{}},{"type":"skip_model"}]})
}
#[tokio::test]
async fn pc7_model_rules_organize_digest_signal_undo_and_destination_refusal()
-> Result<(), HarnessError> {
    butler_e2e::gate!();
    let setup = setup("PC7")?;
    let root = package(&setup.sandbox.home, false)?;
    let s = setup.start().await?;
    install(&s, &root).await?;
    let id = connect(&s, "batch", 0.03).await?;
    account(&s, &id, "connected").await?;
    invoke(&s, "connector_rule_set", rule()).await?;
    count(&s, "SELECT count(*) FROM app_connector_rules", 1).await?;
    invoke(&s, "connector_rule_set", rule()).await?;
    count(
        &s,
        "SELECT count(*) FROM events WHERE type='connector.rule_announced'",
        1,
    )
    .await?;
    emit(&s, &id, vec![event("matched")]).await?;
    count(
        &s,
        "SELECT count(*) FROM app_connector_events WHERE skip_model=1 AND ready=1",
        1,
    )
    .await?;
    let calls = fs::read_to_string(data(&s).join(format!("{id}-calls")))?;
    assert_eq!(calls.lines().count(), 2);
    assert!(calls.contains("event_id"));
    assert_eq!(
        s.gw.approval_requests("general").await?,
        Vec::<Value>::new()
    );
    count(
        &s,
        "SELECT count(*) FROM app_connector_deliveries WHERE admitted_at IS NOT NULL",
        1,
    )
    .await?;
    let payload: String =
        db(&s).query_row("SELECT payload FROM app_connector_deliveries", [], |r| {
            r.get(0)
        })?;
    let payload: Value = serde_json::from_str(&payload)?;
    assert_eq!(payload["events"], json!([]));
    assert_eq!(payload["digest"][0]["count"], 1);
    let mut signal = event("signal");
    signal["signal"] = json!({"type":"returned","ref":"matched"});
    emit(&s, &id, vec![signal]).await?;
    count(&s, "SELECT sum(signals) FROM app_connector_rules", 1).await?;
    let mut outward = rule();
    outward["id"] = "outward".into();
    outward["actions"] = json!([{"type":"organize","tool":"events/send","arguments":{}}]);
    invoke(&s, "connector_rule_set", outward).await?;
    for destination in ["bin", "noise", "missing"] {
        let mut refused = rule();
        refused["id"] = "refused".into();
        refused["actions"][0]["arguments"]["destination"] = destination.into();
        invoke(&s, "connector_rule_set", refused).await?;
    }
    count(&s, "SELECT count(*) FROM app_connector_rules", 1).await?;
    let all = s
        .provider()?
        .requests()
        .iter()
        .map(Value::to_string)
        .collect::<String>();
    assert!(all.contains("connector_rule_action_not_organize"));
    assert!(all.contains("connector_destination_refused"));
    let removed = api(&s, Method::DELETE, "/connector-rules/updates", None).await?;
    assert_eq!(removed.status, 200);
    emit(&s, &id, vec![event("unmatched")]).await?;
    count(
        &s,
        "SELECT count(*) FROM app_connector_events WHERE delivered_at IS NOT NULL",
        1,
    )
    .await?;
    let rules = api(&s, Method::GET, "/connector-rules", None).await?;
    assert_eq!(rules.data()["rules"], json!([]));
    s.finish().await
}

#[tokio::test]
async fn read_only_rules_accept_internal_actions_and_skip_organize_at_apply()
-> Result<(), HarnessError> {
    butler_e2e::gate!();
    let setup = setup("PC-READ-ONLY")?;
    let root = package(&setup.sandbox.home, false)?;
    let s = setup.start().await?;
    install(&s, &root).await?;
    let id = connect(&s, "batch", 0.025).await?;
    account(&s, &id, "connected").await?;
    invoke(&s, "connector_rule_set", rule()).await?;
    let r =
        s.gw.patch("/settings", json!({"access_mode":"read_only"}))
            .await?;
    assert_eq!(r.status, 200);
    emit(&s, &id, vec![event("restricted")]).await?;
    count(
        &s,
        "SELECT count(*) FROM app_connector_events WHERE actions_json LIKE '%connector_read_only%'",
        1,
    )
    .await?;
    assert!(!data(&s).join(format!("{id}-calls")).exists());
    let mut organize = rule();
    organize["id"] = "refused".into();
    invoke(&s, "connector_rule_set", organize).await?;
    let mut internal = rule();
    internal["id"] = "internal".into();
    internal["actions"] = json!([{"type":"tag","tag":"later"},{"type":"skip_model"}]);
    invoke(&s, "connector_rule_set", internal).await?;
    count(&s, "SELECT count(*) FROM app_connector_rules", 2).await?;
    invoke(&s, "connector_rule_list", json!({})).await?;
    invoke(&s, "connector_rule_remove", json!({"id":"internal"})).await?;
    count(&s, "SELECT count(*) FROM app_connector_rules", 1).await?;
    assert!(
        s.provider()?
            .requests()
            .iter()
            .any(|r| r.to_string().contains("connector_rule_read_only"))
    );
    assert_eq!(
        s.gw.approval_requests("general").await?,
        Vec::<Value>::new()
    );
    s.finish().await
}
