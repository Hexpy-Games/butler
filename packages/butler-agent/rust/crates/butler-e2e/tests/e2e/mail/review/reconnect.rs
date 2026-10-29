use super::*;
#[tokio::test]
async fn review_host_no_idle_crashes_after_at_most_three_logins() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    let fake = FakeImap::start().await?;
    fake.idle_supported(false);
    let setup = setup("MAIL-NO-IDLE")?;
    let root = package(&setup.sandbox.home)?;
    let s = setup.start().await?;
    install(&s, &root).await?;
    let response = api(&s, Method::POST, "/connectors/mail/mail/accounts", Some(json!({"fields":fields(&fake),"secrets":{"IMAP_PASSWORD":"password"},"revision":revision(&s).await?}))).await?;
    assert_eq!(response.status, 200);
    wait(|| async {
        Ok(api(&s, Method::GET, "/connectors", None)
            .await?
            .text
            .contains("crashed"))
    })
    .await?;
    let logins = fake
        .commands()
        .iter()
        .filter(|c| c.contains(" LOGIN "))
        .count();
    eprintln!("MAIL unsupported_idle_logins={logins}");
    assert!(logins <= 3, "unexpected LOGIN attempts: {logins}");
    let direct = Direct::open(&s, &fake, "unsupported", "password").await?;
    let (status, stderr) = direct.subscribe_until_exit("password").await?;
    assert!(!status.success());
    assert_eq!(stderr.trim(), "mail_idle_unsupported");
    s.finish().await
}

#[tokio::test]
async fn review_recovered_idle_resets_reconnect_backoff() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    let fake = FakeImap::start().await?;
    fake.flap(2);
    let s = setup("MAIL-BACKOFF")?.start().await?;
    let direct = Direct::open(&s, &fake, "backoff", "password").await?;
    direct.subscribe().await?;
    wait(|| async {
        Ok(fake
            .commands()
            .iter()
            .filter(|c| c.ends_with(" IDLE"))
            .count()
            == 3)
    })
    .await?;
    // Allow the IDLE continuation to reach the client, then close this healthy stream.
    tokio::time::sleep(Duration::from_millis(100)).await;
    fake.disconnect();
    let done_at = Instant::now();
    wait(|| async { Ok(fake.connections().len() >= 4) }).await?;
    let elapsed = done_at.elapsed();
    eprintln!("MAIL backoff_retry_ms={}", elapsed.as_millis());
    butler_e2e::assert_wall_clock_budget!(
        elapsed,
        Duration::from_secs(2),
        "mail reconnect backoff reset"
    );
    fake.deliver(
        "INBOX",
        &rfc822(
            "recovered",
            "Recovered",
            "owner@example.test",
            "Complete body",
            "",
        ),
    );
    let batch = arrived(&direct).await?;
    assert_eq!(batch["events"].as_array().unwrap().len(), 1);
    assert_eq!(batch["events"][0]["dedupe_key"], "recovered");
    direct.kill().await?;
    s.finish().await
}
