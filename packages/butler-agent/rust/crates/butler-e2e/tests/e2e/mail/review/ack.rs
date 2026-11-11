use super::*;
#[tokio::test]
async fn review_ack_survives_kill_and_only_ack_advances_cursor() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    let fake = FakeImap::start().await?;
    let s = setup("MAIL-ACK")?.start().await?;
    let direct = Direct::open(&s, &fake, "ack", "password").await?;
    direct.subscribe().await?;
    wait(|| async { Ok(fake.commands().iter().any(|c| c.ends_with(" IDLE"))) }).await?;
    fake.deliver(
        "INBOX",
        &rfc822("pending", "Pending", "owner@example.test", "Body", ""),
    );
    let first = arrived(&direct).await?;
    let path = s.sandbox.data.join("plugins/data/mail/ack/state.json");
    let saved: Value = serde_json::from_slice(&fs::read(&path)?)?;
    assert_eq!(
        saved["cursor"]["last"], 0,
        "reading advanced unacknowledged UID"
    );
    assert_eq!(
        direct.read("connector://events").await?,
        first,
        "read consumed events"
    );
    direct.kill().await?;
    let direct = Direct::open(&s, &fake, "ack", "password").await?;
    direct.subscribe().await?;
    let replay = arrived(&direct).await?;
    assert_eq!(replay, first, "crash lost or changed pending batch");
    // This is the host persistence boundary: commit the item before acknowledging.
    let store = rusqlite::Connection::open(s.sandbox.home.join("host-items.sqlite"))?;
    store.execute_batch("CREATE TABLE items(id TEXT PRIMARY KEY, event TEXT NOT NULL)")?;
    for batch in [&first, &replay] {
        for event in batch["events"].as_array().unwrap() {
            store.execute(
                "INSERT OR IGNORE INTO items VALUES(?1,?2)",
                [event["id"].as_str().unwrap(), &event.to_string()],
            )?;
        }
    }
    assert_eq!(
        store.query_row("SELECT count(*) FROM items", [], |r| r.get::<_, i64>(0))?,
        1
    );
    let ack = format!(
        "connector://events?after={}",
        replay["cursor"].as_str().unwrap()
    );
    assert_eq!(direct.read(&ack).await?["ok"], true);
    assert_eq!(direct.read(&ack).await?["ok"], true);
    assert_eq!(
        direct.read("connector://events").await?["events"],
        json!([])
    );
    direct.kill().await?;
    let direct = Direct::open(&s, &fake, "ack", "password").await?;
    direct.subscribe().await?;
    assert_eq!(
        direct.read("connector://events").await?["events"],
        json!([])
    );
    direct.close("password").await?;
    s.finish().await
}

#[tokio::test]
async fn review_upstream_action_deadline_respects_host_margin() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    let fake = FakeImap::start().await?;
    let s = setup("MAIL-DEADLINE")?.start().await?;
    let direct = Direct::open(&s, &fake, "deadline", "password").await?;
    fake.stall_command(Some("SELECT"));
    let started = Instant::now();
    let result = tokio::time::timeout(
        Duration::from_millis(2900),
        direct.call("mark_read", json!({"event_id":id("INBOX",1,1)})),
    )
    .await
    .map_err(|_| {
        HarnessError("connector outlived upstream deadline before 3000ms host deadline".into())
    })??;
    eprintln!(
        "MAIL upstream_deadline_ms={}",
        started.elapsed().as_millis()
    );
    butler_e2e::assert_wall_clock_budget!(
        started.elapsed(),
        Duration::from_millis(2500),
        "mail upstream deadline"
    );
    assert!(
        result.to_string().contains("mail_operation_timeout"),
        "{result}"
    );
    direct.close("password").await?;
    s.finish().await
}

#[tokio::test]
async fn review_host_kill_before_ack_replays_once_to_real_host() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    let fake = FakeImap::start().await?;
    let setup = setup("MAIL-HOST-ACK")?;
    let root = package(&setup.sandbox.home)?;
    let s = setup.start().await?;
    install(&s, &root).await?;
    let account = connect(&s, &fake, "password").await?;
    enabled(&s, &account, false).await?;
    let direct = Direct::open(&s, &fake, &account, "password").await?;
    direct.subscribe().await?;
    wait(|| async {
        Ok(fake
            .commands()
            .iter()
            .filter(|c| c.ends_with(" IDLE"))
            .count()
            >= 2)
    })
    .await?;
    fake.deliver(
        "INBOX",
        &rfc822(
            "host-crash",
            "Crash recovery",
            "owner@example.test",
            "Complete content",
            "",
        ),
    );
    let read = arrived(&direct).await?;
    assert_eq!(read["events"].as_array().unwrap().len(), 1);
    // Kill the account transport after its read, before any acknowledgement.
    direct.kill().await?;
    s.provider()?.set_chat_responder(stub::run);
    enabled(&s, &account, true).await?;
    count(
        &s,
        "SELECT count(*) FROM app_connector_events WHERE delivered_at IS NOT NULL",
        1,
    )
    .await?;
    assert_eq!(event(&s, "host-crash")["subject"], "Crash recovery");
    enabled(&s, &account, false).await?;
    enabled(&s, &account, true).await?;
    count(&s, "SELECT count(*) FROM app_connector_events", 1).await?;
    assert_eq!(
        db(&s).query_row("SELECT count(*) FROM app_connector_deliveries", [], |r| r
            .get::<_, i64>(
            0
        ))?,
        1
    );
    s.finish().await
}
