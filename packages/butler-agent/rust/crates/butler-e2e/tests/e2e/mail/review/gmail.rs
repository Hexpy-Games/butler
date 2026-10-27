use super::*;

#[tokio::test]
async fn review_gmail_archive_labels_and_moves_preserve_all_mail() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    let fake = FakeImap::start().await?;
    fake.gmail();
    let s = setup("MAIL-GMAIL")?.start().await?;
    let direct = Direct::open(&s, &fake, "gmail", "password").await?;
    let raw = rfc822(
        "gmail",
        "Shared message",
        "owner@example.test",
        "Complete body",
        "",
    );
    let uid = fake.deliver("INBOX", &raw);
    for destination in ["Bin", "Spam", "All"] {
        for action in ["label", "move"] {
            let before = format!("{:?}", fake.snapshot());
            let mut args = json!({"event_id":id("INBOX",1,uid)});
            args[if action == "label" {
                "label"
            } else {
                "destination"
            }] = destination.into();
            let result = direct.call(action, args).await?;
            assert!(
                result.to_string().contains("mail_destination_refused"),
                "{result}"
            );
            assert_eq!(format!("{:?}", fake.snapshot()), before);
        }
    }
    let result = direct
        .call(
            "label",
            json!({"event_id":id("INBOX",1,uid),"label":"Unknown"}),
        )
        .await?;
    assert_ne!(result["isError"], true, "{result}");
    assert_eq!(fake.snapshot()["Unknown"][0].raw, raw);
    let result = direct
        .call("archive", json!({"event_id":id("INBOX",1,uid)}))
        .await?;
    assert_ne!(result["isError"], true, "{result}");
    let snapshot = fake.snapshot();
    assert!(snapshot["INBOX"].is_empty());
    assert_eq!(snapshot["All"].len(), 1);
    assert_eq!(snapshot["All"][0].raw, raw);
    assert_eq!(snapshot["Unknown"].len(), 1);
    assert!(snapshot["Archive"].is_empty());
    let uid = snapshot["Unknown"][0].uid;
    let result = direct
        .call(
            "move",
            json!({"event_id":id("Unknown",1,uid),"destination":"Filed"}),
        )
        .await?;
    assert_ne!(result["isError"], true, "{result}");
    let snapshot = fake.snapshot();
    assert!(snapshot["Unknown"].is_empty());
    assert_eq!(snapshot["Filed"].len(), 1);
    assert_eq!(snapshot["Filed"][0].raw, raw);
    assert_eq!(snapshot["All"].len(), 1);
    assert_eq!(snapshot["All"][0].raw, raw);
    for source in ["All", "Bin", "Spam"] {
        let uid = if source == "All" {
            snapshot["All"][0].uid
        } else {
            fake.deliver(
                source,
                &rfc822(source, source, "owner@example.test", "Body", ""),
            )
        };
        for action in ["archive", "move"] {
            let before = format!("{:?}", fake.snapshot());
            let result = direct
                .call(
                    action,
                    json!({"event_id":id(source,1,uid),"destination":"Filed"}),
                )
                .await?;
            assert!(
                result.to_string().contains("mail_source_refused"),
                "{result}"
            );
            assert_eq!(format!("{:?}", fake.snapshot()), before);
        }
    }
    assert!(
        !fake
            .commands()
            .iter()
            .any(|c| c.contains("\\Deleted") || c.contains("EXPUNGE"))
    );
    assert!(
        fake.snapshot()
            .values()
            .flatten()
            .all(|m| !m.flags.contains(&"\\Deleted".into()))
    );
    direct.close("password").await?;
    s.finish().await
}
