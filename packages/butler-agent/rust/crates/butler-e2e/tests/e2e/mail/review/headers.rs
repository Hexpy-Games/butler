use super::*;
#[tokio::test]
async fn review_host_large_headers_delivered_with_utf8_safe_attribute_caps()
-> Result<(), HarnessError> {
    butler_e2e::gate!();
    let fake = FakeImap::start().await?;
    let setup = setup("MAIL-HEADERS")?;
    let root = package(&setup.sandbox.home)?;
    let s = setup.start().await?;
    install(&s, &root).await?;
    let direct = Direct::open(&s, &fake, "headers", "password").await?;
    direct.subscribe().await?;
    wait(|| async {
        Ok(fake
            .commands()
            .iter()
            .filter(|c| c.ends_with(" IDLE"))
            .count()
            == 1)
    })
    .await?;
    let value = "한".repeat(7000);
    fake.deliver(
        "INBOX",
        &rfc822(
            "large",
            "Large",
            "owner@example.test",
            "Complete body",
            &format!("List-Id: {value}\r\nReply-To: {value}\r\n"),
        ),
    );
    let batch = arrived(&direct).await?;
    assert!(
        batch["events"][0]["attributes"]["List-Id"]
            .as_str()
            .unwrap()
            .len()
            <= 4096,
        "oversized attribute reaches host"
    );
    direct.close("password").await?;
    let host = FakeImap::start().await?;
    connect(&s, &host, "password").await?;
    host.deliver(
        "INBOX",
        &rfc822(
            "large",
            "Large",
            "owner@example.test",
            "Complete body",
            &format!("List-Id: {value}\r\nReply-To: {value}\r\n"),
        ),
    );
    count(&s, "SELECT count(*) FROM app_connector_events", 1).await?;
    let event = event(&s, "large");
    for header in ["List-Id", "Reply-To"] {
        let actual = event["attributes"][header].as_str().unwrap();
        assert_eq!(actual.len(), 4095);
        assert!(value.starts_with(actual));
    }
    assert_eq!(event["subject"], "Large");
    assert!(event["snippet"].as_str().unwrap().contains("Complete body"));
    s.finish().await
}
