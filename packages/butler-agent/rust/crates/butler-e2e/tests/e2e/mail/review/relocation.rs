use super::*;
#[tokio::test]
async fn review_relocation_refuses_protected_destinations_sources_and_stale_sources()
-> Result<(), HarnessError> {
    butler_e2e::gate!();
    let fake = FakeImap::start().await?;
    let s = setup("MAIL-SOURCES")?.start().await?;
    let direct = Direct::open(&s, &fake, "sources", "password").await?;
    for source in ["All", "Bin", "Spam"] {
        let uid = fake.deliver(
            source,
            &rfc822(source, source, "owner@example.test", "Body", ""),
        );
        let before = format!("{:?}", fake.snapshot());
        for (moves, uidplus) in [(true, true), (false, true)] {
            fake.capabilities(moves, uidplus);
            for action in ["move", "archive"] {
                let result = direct
                    .call(
                        action,
                        json!({"event_id":id(source,1,uid),"destination":"Filed"}),
                    )
                    .await?;
                assert!(
                    result.to_string().contains("mail_source_refused"),
                    "{source} {action}: {result}"
                );
                assert_eq!(format!("{:?}", fake.snapshot()), before);
            }
        }
    }
    let uid = fake.deliver(
        "INBOX",
        &rfc822("safe", "Safe", "owner@example.test", "Body", ""),
    );
    let before = format!("{:?}", fake.snapshot());
    for (moves, uidplus) in [(true, true), (false, true)] {
        fake.capabilities(moves, uidplus);
        for destination in ["All", "Bin", "Spam"] {
            let result = direct
                .call(
                    "move",
                    json!({"event_id":id("INBOX",1,uid),"destination":destination}),
                )
                .await?;
            assert!(
                result.to_string().contains("mail_destination_refused"),
                "{result}"
            );
            assert_eq!(format!("{:?}", fake.snapshot()), before);
        }
    }
    let uid = fake.deliver(
        "Filed",
        &rfc822("exists", "Exists", "owner@example.test", "Body", ""),
    );
    for event in [id("Filed", 2, uid), id("Filed", 1, uid + 100)] {
        let before = fake.commands().len();
        let result = direct
            .call("move", json!({"event_id":event,"destination":"Archive"}))
            .await?;
        assert_eq!(result["isError"], true, "{result}");
        assert!(
            !fake.commands()[before..]
                .iter()
                .any(|c| c.contains("UID COPY")
                    || c.contains("UID MOVE")
                    || c.contains("UID STORE"))
        );
    }
    assert!(
        !fake
            .commands()
            .iter()
            .any(|c| c.contains("\\Deleted") || c.contains("EXPUNGE"))
    );
    direct.close("password").await?;
    s.finish().await
}

#[tokio::test]
async fn review_special_use_extended_list_and_unknown_roles_fail_closed() -> Result<(), HarnessError>
{
    butler_e2e::gate!();
    let fake = FakeImap::start().await?;
    fake.special_use(true, true);
    let s = setup("MAIL-SPECIAL-USE")?.start().await?;
    let direct = Direct::open(&s, &fake, "roles", "password").await?;
    let destinations = direct.read("connector://destinations").await?;
    assert!(
        destinations["destinations"]
            .as_array()
            .unwrap()
            .iter()
            .any(|d| d["id"] == "Bin" && d["roles"] == json!(["trash"]))
    );
    assert!(
        fake.commands()
            .iter()
            .any(|c| c.ends_with("LIST \"\" \"*\" RETURN (SPECIAL-USE)"))
    );
    let inbox = fake.deliver(
        "INBOX",
        &rfc822("roles", "Roles", "owner@example.test", "Body", ""),
    );
    let ordinary = fake.deliver(
        "Unknown",
        &rfc822("source", "Source", "owner@example.test", "Body", ""),
    );
    let before = format!("{:?}", fake.snapshot());
    {
        fake.special_use(false, true);
        let destinations = direct.read("connector://destinations").await?;
        assert!(
            destinations["destinations"]
                .as_array()
                .unwrap()
                .iter()
                .all(|d| d["roles_known"] == false)
        );
        for (source, uid, destination) in
            [("INBOX", inbox, "Filed"), ("Unknown", ordinary, "INBOX")]
        {
            let result = direct
                .call(
                    "move",
                    json!({"event_id":id(source,1,uid),"destination":destination}),
                )
                .await?;
            assert!(
                result.to_string().contains("mail_source_refused"),
                "{result}"
            );
            assert_eq!(format!("{:?}", fake.snapshot()), before);
        }
    }
    assert!(!fake.commands().iter().any(|c| c.contains("UID MOVE")
        || c.contains("UID COPY")
        || c.contains("\\Deleted")
        || c.contains("EXPUNGE")));
    direct.close("password").await?;
    s.finish().await
}

#[tokio::test]
async fn review_archive_declares_relocation_so_read_happens_first() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    let fake = FakeImap::start().await?;
    let setup = setup("MAIL-ARCHIVE-ORDER")?;
    let root = package(&setup.sandbox.home)?;
    let s = setup.start().await?;
    install(&s, &root).await?;
    connect(&s, &fake, "password").await?;
    invoke(&s, "connector_rule_set", json!({"id":"archive-order","connector":"mail/mail","title":"File updates","reason":"Keep updates read","match":[{"field":"attributes.List-Id","op":"equals","value":"<archive.example.test>"}],"actions":[{"type":"organize","tool":"mail/archive","arguments":{}},{"type":"organize","tool":"mail/mark_read","arguments":{}},{"type":"skip_model"}]})).await?;
    fake.deliver(
        "INBOX",
        &rfc822(
            "archive-order",
            "Archive order",
            "owner@example.test",
            "Complete body",
            "List-Id: <archive.example.test>\r\n",
        ),
    );
    wait(|| async { Ok(fake.snapshot()["Archive"].len() == 1) }).await?;
    assert!(
        fake.snapshot()["Archive"][0]
            .flags
            .contains(&"\\Seen".into()),
        "archive ran before mark_read"
    );
    assert!(fake.snapshot()["INBOX"].is_empty());
    s.finish().await
}

#[tokio::test]
async fn review_list_attributes_without_capability_establish_roles() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    let fake = FakeImap::start().await?;
    fake.special_use(false, false);
    let s = setup("MAIL-LIST-ROLES")?.start().await?;
    let direct = Direct::open(&s, &fake, "list-roles", "password").await?;
    let raw = rfc822(
        "list-roles",
        "Attribute roles",
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
    assert_ne!(result["isError"], true, "{result}");
    let destinations = direct.read("connector://destinations").await?;
    assert!(
        destinations["destinations"]
            .as_array()
            .unwrap()
            .iter()
            .all(|d| d["roles_known"] == true)
    );
    let snapshot = fake.snapshot();
    assert!(snapshot["INBOX"].is_empty());
    assert_eq!(snapshot["Filed"].len(), 1);
    assert_eq!(snapshot["Filed"][0].raw, raw);
    for destination in ["Bin", "Spam", "All"] {
        let result = direct.call("move", json!({"event_id":id("Filed",1,snapshot["Filed"][0].uid),"destination":destination})).await?;
        assert!(
            result.to_string().contains("mail_destination_refused"),
            "{result}"
        );
        assert_eq!(format!("{:?}", fake.snapshot()), format!("{snapshot:?}"));
    }
    fake.assert_no_forbidden_destinations();
    direct.close("password").await?;
    s.finish().await
}
