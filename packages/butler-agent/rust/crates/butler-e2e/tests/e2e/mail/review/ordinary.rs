use super::*;

#[tokio::test]
async fn review_plain_folders_allow_move_source_and_keyword_label() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    let fake = FakeImap::start().await?;
    let s = setup("MAIL-PLAIN-FOLDERS")?.start().await?;
    let direct = Direct::open(&s, &fake, "ordinary", "password").await?;
    let raw = rfc822(
        "ordinary",
        "Ordinary",
        "owner@example.test",
        "Complete body",
        "",
    );
    let uid = fake.deliver("INBOX", &raw);
    let result = direct
        .call(
            "move",
            json!({"event_id":id("INBOX",1,uid),"destination":"Filed"}),
        )
        .await?;
    assert_ne!(result["isError"], true, "plain-folder move: {result}");
    assert!(fake.snapshot()["INBOX"].is_empty());
    assert_eq!(fake.snapshot()["Filed"].len(), 1);
    assert_eq!(fake.snapshot()["Filed"][0].raw, raw);
    let destinations = direct.read("connector://destinations").await?;
    for folder in ["Filed", "Unknown"] {
        let mailbox = destinations["destinations"]
            .as_array()
            .unwrap()
            .iter()
            .find(|d| d["id"] == folder)
            .unwrap();
        assert_eq!(mailbox["roles"], json!([]));
        assert_eq!(mailbox["roles_known"], true);
    }
    let uid = fake.snapshot()["Filed"][0].uid;
    let result = direct
        .call(
            "label",
            json!({"event_id":id("Filed",1,uid),"label":"Filed"}),
        )
        .await?;
    assert_ne!(result["isError"], true, "plain-folder label: {result}");
    assert!(fake.snapshot()["Filed"][0].flags.contains(&"Filed".into()));
    let result = direct
        .call(
            "move",
            json!({"event_id":id("Filed",1,uid),"destination":"Unknown"}),
        )
        .await?;
    assert_ne!(result["isError"], true, "plain-folder source: {result}");
    assert!(fake.snapshot()["Filed"].is_empty());
    assert_eq!(fake.snapshot()["Unknown"].len(), 1);
    assert_eq!(fake.snapshot()["Unknown"][0].raw, raw);
    assert!(
        fake.snapshot()["Unknown"][0]
            .flags
            .contains(&"Filed".into())
    );
    direct.close("password").await?;
    s.finish().await
}

#[tokio::test]
async fn review_host_refuses_destinations_without_special_use() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    let fake = FakeImap::start().await?;
    // Unknown roles require neither the capability nor special-use attributes.
    fake.special_use(false, true);
    let setup = setup("MAIL-HOST-UNKNOWN-ROLES")?;
    let root = package(&setup.sandbox.home)?;
    let s = setup.start().await?;
    install(&s, &root).await?;
    connect(&s, &fake, "password").await?;
    for destination in ["Filed", "INBOX", "Archive"] {
        invoke(&s, "connector_rule_set", json!({"id":"unknown-roles","connector":"mail/mail","title":"File mail","reason":"Organize mail","match":[{"field":"subject","op":"equals","value":"Update"}],"actions":[{"type":"organize","tool":"mail/move","arguments":{"destination":destination}}]})).await?;
        count(&s, "SELECT count(*) FROM app_connector_rules", 0).await?;
    }
    assert!(
        s.provider()?
            .requests()
            .iter()
            .any(|r| r.to_string().contains("connector_destination_refused"))
    );
    assert!(!fake.commands().iter().any(|c| c.contains("UID MOVE")
        || c.contains("UID COPY")
        || c.contains("\\Deleted")
        || c.contains("EXPUNGE")));
    s.finish().await
}
