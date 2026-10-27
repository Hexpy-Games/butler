use super::*;

#[tokio::test]
async fn review_blank_conditions_are_rejected_on_set_and_patch() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    let setup = setup("PC-BLANK")?;
    let root = package(&setup.sandbox.home, false)?;
    let s = setup.start().await?;
    install(&s, &root).await?;
    let id = connect(&s, "immediate", 10.0).await?;
    account(&s, &id, "connected").await?;
    let rule = json!({"id":"blank","connector":"source/items","title":"Preference","reason":"Preference","match":[{"field":"subject","op":"contains","value":""}],"actions":[{"type":"tag","tag":"tagged"}]});
    for value in ["", " ", "\t\n"] {
        let mut invalid = rule.clone();
        invalid["match"][0]["value"] = value.into();
        invoke(&s, "connector_rule_set", invalid).await?;
        let n: i64 =
            db(&s).query_row("SELECT count(*) FROM app_connector_rules", [], |r| r.get(0))?;
        assert_eq!(n, 0, "blank condition was accepted: {value:?}");
    }
    let mut valid = rule.clone();
    valid["match"][0]["value"] = "Item".into();
    invoke(&s, "connector_rule_set", valid).await?;
    let patched = api(
        &s,
        Method::PATCH,
        "/connector-rules/blank",
        Some(json!({"match":rule["match"]})),
    )
    .await?;
    assert_eq!(patched.status, 400, "{patched:?}");
    assert!(patched.text.contains("connector_rule_invalid"));
    // A legacy persisted invalid condition must also fail closed at apply time.
    let connection =
        rusqlite::Connection::open(s.sandbox.data.join("app-server/butler-client.sqlite"))?;
    connection.execute(
        "UPDATE app_connector_rules SET rule_json=?1",
        [rule.to_string()],
    )?;
    drop(connection);
    emit(&s, &id, vec![event("legacy")]).await?;
    count(
        &s,
        "SELECT count(*) FROM app_connector_events WHERE ready=1",
        1,
    )
    .await?;
    let rules: String =
        db(&s).query_row("SELECT matched_rules FROM app_connector_events", [], |r| {
            r.get(0)
        })?;
    assert_eq!(rules, "[]");
    s.finish().await
}

#[tokio::test]
async fn review_old_source_timestamp_survives_later_arrival() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    let setup = setup("PC-RETENTION")?;
    let root = package(&setup.sandbox.home, false)?;
    let s = setup.start().await?;
    install(&s, &root).await?;
    let id = connect(&s, "batch", 0.05).await?;
    account(&s, &id, "connected").await?;
    let mut old = event("old-source");
    old["received_at"] = "2000-01-01T00:00:00Z".into();
    emit(&s, &id, vec![old]).await?;
    count(
        &s,
        "SELECT count(*) FROM app_connector_events WHERE ready=1",
        1,
    )
    .await?;
    emit(&s, &id, vec![event("new-source")]).await?;
    count(
        &s,
        "SELECT count(*) FROM app_connector_events WHERE delivered_at IS NOT NULL",
        2,
    )
    .await?;
    let payload: String =
        db(&s).query_row("SELECT payload FROM app_connector_deliveries", [], |r| {
            r.get(0)
        })?;
    let payload: Value = serde_json::from_str(&payload)?;
    assert_eq!(payload["events"].as_array().unwrap().len(), 2);
    assert_eq!(payload["events"][0]["id"], "old-source");
    s.finish().await
}

#[tokio::test]
async fn review_relocating_actions_execute_last_and_are_unique() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    let setup = setup("PC-ORDER")?;
    let root = package(&setup.sandbox.home, false)?;
    let s = setup.start().await?;
    install(&s, &root).await?;
    let id = connect(&s, "immediate", 10.0).await?;
    account(&s, &id, "connected").await?;
    let rule = json!({"id":"order","connector":"source/items","title":"Preference","reason":"Preference","match":[{"field":"subject","op":"contains","value":"Item"}],"actions":[{"type":"organize","tool":"events/move","arguments":{"destination":"keep"}},{"type":"organize","tool":"events/mark_read","arguments":{}}]});
    invoke(&s, "connector_rule_set", rule.clone()).await?;
    emit(&s, &id, vec![event("ordered")]).await?;
    count(
        &s,
        "SELECT count(*) FROM app_connector_events WHERE ready=1",
        1,
    )
    .await?;
    let calls = fs::read_to_string(data(&s).join(format!("{id}-calls")))?;
    let calls = calls
        .lines()
        .map(serde_json::from_str::<Value>)
        .collect::<Result<Vec<_>, _>>()?;
    assert_eq!(calls.len(), 2);
    assert_eq!(
        calls[0]["name"], "mark_read",
        "non-relocating actions must precede relocation"
    );
    assert_eq!(calls[1]["name"], "move");
    assert_eq!(
        fs::read_to_string(data(&s).join(format!("{id}-applied")))?
            .lines()
            .count(),
        2
    );
    let actions: String =
        db(&s).query_row("SELECT actions_json FROM app_connector_events", [], |r| {
            r.get(0)
        })?;
    assert_eq!(
        serde_json::from_str::<Value>(&actions)?
            .as_array()
            .unwrap()
            .len(),
        2
    );
    let mut invalid = rule.clone();
    invalid["id"] = "twice".into();
    invalid["actions"] = json!([rule["actions"][0], rule["actions"][0]]);
    invoke(&s, "connector_rule_set", invalid).await?;
    assert_eq!(
        db(&s).query_row("SELECT count(*) FROM app_connector_rules", [], |r| r
            .get::<_, i64>(0))?,
        1
    );
    s.finish().await
}

#[tokio::test]
async fn review_silent_update_restarts_the_account_on_new_digest() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    let setup = setup("PC-UPDATE")?;
    let root = package(&setup.sandbox.home, false)?;
    let s = setup.start().await?;
    install(&s, &root).await?;
    let id = connect(&s, "immediate", 10.0).await?;
    account(&s, &id, "connected").await?;
    let before = fs::read_to_string(data(&s).join(format!("{id}-starts")))?;
    invoke(&s,"connector_rule_set",json!({"id":"live-call","connector":"source/items","title":"Preference","reason":"Preference","match":[{"field":"subject","op":"contains","value":"Item"}],"actions":[{"type":"organize","tool":"events/mark_read","arguments":{}}]})).await?;
    let slow = data(&s).join(format!("{id}-slow-operation"));
    fs::write(&slow, "1")?;
    emit(&s, &id, vec![event("inflight")]).await?;
    let calls = data(&s).join(format!("{id}-calls"));
    let deadline = Instant::now() + Duration::from_secs(15);
    while !calls.exists() {
        assert!(Instant::now() < deadline, "outward call never started");
        tokio::time::sleep(Duration::from_millis(25)).await;
    }
    let mut manifest: Value = serde_json::from_slice(&fs::read(root.join("plugin.json"))?)?;
    manifest["version"] = "1.0.1".into();
    fs::write(root.join("plugin.json"), manifest.to_string())?;
    let checked = api(
        &s,
        Method::POST,
        "/plugins/source/check",
        Some(json!({"force":true})),
    )
    .await?;
    assert_eq!(checked.status, 200, "{checked:?}");
    assert_eq!(checked.data()["applied"], true, "{checked:?}");
    count(
        &s,
        "SELECT count(*) FROM app_connector_events WHERE delivered_at IS NOT NULL",
        1,
    )
    .await?;
    let results: String =
        db(&s).query_row("SELECT actions_json FROM app_connector_events", [], |r| {
            r.get(0)
        })?;
    assert!(
        results.contains("upstream_deadline_exceeded"),
        "update abandoned in-flight call: {results}"
    );
    fs::remove_file(slow)?;
    account(&s, &id, "connected").await?;
    let after = fs::read_to_string(data(&s).join(format!("{id}-starts")))?;
    assert_eq!(
        after.lines().count(),
        before.lines().count() + 1,
        "silent update retained old process"
    );
    let old: Value = serde_json::from_str(before.lines().last().unwrap())?;
    let new: Value = serde_json::from_str(after.lines().last().unwrap())?;
    assert_ne!(
        old["executable"], new["executable"],
        "account did not move to the new content store"
    );
    emit(&s, &id, vec![event("updated")]).await?;
    count(
        &s,
        "SELECT count(*) FROM app_connector_events WHERE delivered_at IS NOT NULL",
        2,
    )
    .await?;
    s.finish().await
}
