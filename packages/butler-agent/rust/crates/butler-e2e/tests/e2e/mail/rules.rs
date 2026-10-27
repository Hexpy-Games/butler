use super::*;
fn rule() -> Value {
    json!({"id":"mail-updates","connector":"mail/mail","title":"정기 메일 정리","reason":"반복된 메일을 기존 폴더에 정리","match":[{"field":"attributes.List-Id","op":"equals","value":"<updates.example.test>"}],"actions":[{"type":"organize","tool":"mail/mark_read","arguments":{}},{"type":"organize","tool":"mail/move","arguments":{"destination":"Filed"}},{"type":"skip_model"}]})
}
#[tokio::test]
async fn ss11_model_rule_files_existing_folder_digests_and_records_returned_signal()
-> Result<(), HarnessError> {
    butler_e2e::gate!();
    let fake = FakeImap::start().await?;
    let setup = setup("SS11-MAIL")?;
    let root = package(&setup.sandbox.home)?;
    let s = setup.start().await?;
    install(&s, &root).await?;
    s.provider()?.set_chat_responder(stub::run);
    let id = connect(&s, &fake, "mail-password").await?;
    for i in 0..20 {
        fake.deliver(
            "INBOX",
            &rfc822(
                &format!("flood-{i}"),
                &format!("Update {i}"),
                "list@example.test",
                "Mechanical update",
                "List-Id: <updates.example.test>\r\n",
            ),
        );
    }
    count(
        &s,
        "SELECT count(*) FROM app_connector_events WHERE delivered_at IS NOT NULL",
        20,
    )
    .await?;
    invoke(&s, "connector_rule_set", rule()).await?;
    invoke(&s, "connector_rule_set", rule()).await?;
    count(
        &s,
        "SELECT count(*) FROM events WHERE type='connector.rule_announced'",
        1,
    )
    .await?;
    assert_eq!(
        s.gw.approval_requests("general").await?,
        Vec::<Value>::new()
    );
    for destination in ["Bin", "Spam", "All"] {
        let mut refused = rule();
        refused["id"] = "refused".into();
        refused["actions"][1]["arguments"]["destination"] = destination.into();
        invoke(&s, "connector_rule_set", refused).await?;
        invoke(&s,"call_mcp_tool",json!({"server_id":"mail/mail","tool_name":"move","arguments":{"event_id":event(&s,"flood-0")["id"],"destination":destination}})).await?;
    }
    assert!(
        s.provider()?
            .requests()
            .iter()
            .any(|r| r.to_string().contains("connector_destination_refused"))
    );
    count(&s, "SELECT count(*) FROM app_connector_rules", 1).await?;
    for i in 0..3 {
        fake.deliver(
            "INBOX",
            &rfc822(
                &format!("filed-{i}"),
                &format!("Filed update {i}"),
                "list@example.test",
                "Mechanical update",
                "List-Id: <updates.example.test>\r\n",
            ),
        );
    }
    count(
        &s,
        "SELECT count(*) FROM app_connector_events WHERE skip_model=1 AND ready=1",
        3,
    )
    .await?;
    wait(|| async { Ok(fake.snapshot()["Filed"].len() == 3) }).await?;
    assert!(
        fake.snapshot()["Filed"]
            .iter()
            .all(|m| m.flags.contains(&"\\Seen".into()))
    );
    count(
        &s,
        "SELECT count(*) FROM app_connector_events WHERE digested_at IS NOT NULL",
        3,
    )
    .await?;
    let payload: String = db(&s).query_row(
        "SELECT payload FROM app_connector_deliveries ORDER BY rowid DESC LIMIT 1",
        [],
        |r| r.get(0),
    )?;
    let payload: Value = serde_json::from_str(&payload)?;
    assert_eq!(payload["events"], json!([]));
    assert_eq!(payload["digest"][0]["count"], 3);
    assert_eq!(
        payload["digest"][0]["subjects"],
        json!(["Filed update 0", "Filed update 1", "Filed update 2"])
    );
    wait(|| async {
        Ok(s.provider()?
            .requests()
            .iter()
            .any(|r| r.to_string().contains("Filed update 2")))
    })
    .await?;
    let direct = direct::Direct::open(&s, &fake, &id, "mail-password").await?;
    for destination in ["Bin", "Spam", "All"] {
        let result = direct
            .call(
                "move",
                json!({"event_id":event(&s,"flood-0")["id"],"destination":destination}),
            )
            .await?;
        assert_eq!(result["isError"], true);
        assert!(result.to_string().contains("mail_destination_refused"));
    }
    direct.close("mail-password").await?;
    fake.move_by_user("filed-0", "INBOX");
    count(&s, "SELECT sum(signals) FROM app_connector_rules", 1).await?;
    count(&s, "SELECT count(*) FROM app_connector_events", 23).await?;
    let listed = api(&s, Method::GET, "/connector-rules", None).await?;
    assert_eq!(listed.data()["rules"][0]["signals"], 1);
    invoke(&s, "connector_rule_list", json!({"connector":"mail/mail"})).await?;
    // Rule narrowing belongs to the separate consolidation slice. This slice records the signal.
    fake.assert_no_forbidden_destinations();
    assert!(
        !fake
            .commands()
            .iter()
            .any(|c| c.contains("\\Deleted") || c.contains("EXPUNGE"))
    );
    s.finish().await
}
