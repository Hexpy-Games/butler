use super::*;
#[tokio::test]
async fn review_done_timeout_reconnects_and_action_deadline_precedes_host()
-> Result<(), HarnessError> {
    butler_e2e::gate!();
    let fake = FakeImap::start().await?;
    let s = setup("MAIL-DONE")?.start().await?;
    let direct = Direct::open(&s, &fake, "done", "password").await?;
    direct.subscribe().await?;
    wait(|| async { Ok(fake.commands().iter().any(|c| c.ends_with(" IDLE"))) }).await?;
    fake.stall_done(true);
    fake.deliver(
        "INBOX",
        &rfc822("after-sleep", "Wake", "owner@example.test", "Body", ""),
    );
    let started = Instant::now();
    let batch = arrived(&direct).await?;
    eprintln!("MAIL done_recovery_ms={}", started.elapsed().as_millis());
    butler_e2e::assert_wall_clock_budget!(
        started.elapsed(),
        Duration::from_secs(5),
        "mail DONE recovery"
    );
    assert_eq!(batch["events"].as_array().unwrap().len(), 1);
    assert_eq!(batch["events"][0]["dedupe_key"], "after-sleep");
    assert!(fake.connections().len() >= 2);
    direct.kill().await?;
    s.finish().await
}
