use super::*;

#[tokio::test]
async fn review_events_survive_crash_before_ack_exactly_once() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    let setup = setup("PC-ACK")?;
    let root = package(&setup.sandbox.home, false)?;
    let s = setup.start().await?;
    install(&s, &root).await?;
    let id = connect(&s, "immediate", 10.0).await?;
    account(&s, &id, "connected").await?;
    fs::write(data(&s).join(format!("{id}-crash-after-read")), "1")?;
    emit(&s, &id, vec![event("durable")]).await?;
    count(
        &s,
        "SELECT count(*) FROM app_connector_events WHERE delivered_at IS NOT NULL",
        1,
    )
    .await?;
    let deadline = Instant::now() + Duration::from_secs(15);
    let ack = data(&s).join(format!("{id}-acked"));
    while fs::read_to_string(&ack).ok().as_deref() != Some("1") {
        assert!(
            Instant::now() < deadline,
            "host never acknowledged persisted events after restart"
        );
        tokio::time::sleep(Duration::from_millis(25)).await;
    }
    assert_eq!(fs::read_to_string(&ack)?, "1");
    assert_eq!(
        db(&s).query_row(
            "SELECT cursor FROM app_connector_cursors WHERE account=?1",
            [&id],
            |r| r.get::<_, String>(0)
        )?,
        "1"
    );
    assert_eq!(
        db(&s).query_row("SELECT count(*) FROM app_connector_events", [], |r| r
            .get::<_, i64>(0))?,
        1
    );
    assert_eq!(
        db(&s).query_row("SELECT count(*) FROM app_connector_deliveries", [], |r| r
            .get::<_, i64>(
            0
        ))?,
        1
    );
    assert_eq!(
        fs::read_to_string(data(&s).join(format!("{id}-starts")))?
            .lines()
            .count(),
        2
    );
    s.finish().await
}

#[tokio::test]
async fn review_unfinished_replay_waits_for_successful_connection() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    let setup = setup("PC-REPLAY")?;
    let root = package(&setup.sandbox.home, false)?;
    let mut s = setup.start().await?;
    install(&s, &root).await?;
    let id = connect(&s, "batch", 0.03).await?;
    account(&s, &id, "connected").await?;
    invoke(&s,"connector_rule_set",json!({"id":"replay","connector":"source/items","title":"Preference","reason":"Preference","match":[{"field":"subject","op":"contains","value":"Item"}],"actions":[{"type":"organize","tool":"events/mark_read","arguments":{}}]})).await?;
    let mut pending = event("unfinished");
    pending["connector"] = "source/items".into();
    pending["account"] = id.clone().into();
    pending["event_id"] = "unfinished-event".into();
    let connection =
        rusqlite::Connection::open(s.sandbox.data.join("app-server/butler-client.sqlite"))?;
    connection.execute("INSERT INTO app_connector_events(event_id,connector,account,dedupe_key,arrived_at,received_at,data_json) VALUES('unfinished-event','source/items',?1,'unfinished',?2,0,?3)", rusqlite::params![id,chrono::Utc::now().to_rfc3339(),pending.to_string()])?;
    drop(connection);
    let blocked = data(&s).join(format!("{id}-connect-blocked"));
    fs::write(&blocked, "1")?;
    s.restart().await?;
    account(&s, &id, "crashed").await?;
    assert_eq!(
        db(&s).query_row("SELECT ready FROM app_connector_events", [], |r| r
            .get::<_, i64>(0))?,
        0,
        "failed connection consumed unfinished work"
    );
    fs::remove_file(blocked)?;
    let r = api(
        &s,
        Method::POST,
        &format!("/connectors/source/items/accounts/{id}/retry"),
        Some(json!({"revision":revision(&s).await?})),
    )
    .await?;
    assert_eq!(r.status, 200, "{r:?}");
    account(&s, &id, "connected").await?;
    count(
        &s,
        "SELECT count(*) FROM app_connector_events WHERE delivered_at IS NOT NULL",
        1,
    )
    .await?;
    let calls = fs::read_to_string(data(&s).join(format!("{id}-calls")))?;
    assert_eq!(calls.lines().count(), 1);
    assert!(calls.contains("mark_read"));
    let actions: String =
        db(&s).query_row("SELECT actions_json FROM app_connector_events", [], |r| {
            r.get(0)
        })?;
    assert!(!actions.contains("connector_disconnected"), "{actions}");
    s.finish().await
}

#[tokio::test]
async fn review_connector_operation_deadline_returns_clean_error() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    let setup = setup("PC-DEADLINE")?;
    let root = package(&setup.sandbox.home, false)?;
    let s = setup.start().await?;
    install(&s, &root).await?;
    let id = connect(&s, "immediate", 10.0).await?;
    account(&s, &id, "connected").await?;
    s.provider()?.set_chat_responder(stub::run);
    emit(&s, &id, vec![event("fetch")]).await?;
    count(
        &s,
        "SELECT count(*) FROM app_connector_events WHERE ready=1",
        1,
    )
    .await?;
    let event_id: String =
        db(&s).query_row("SELECT event_id FROM app_connector_events", [], |r| {
            r.get(0)
        })?;
    fs::write(data(&s).join(format!("{id}-slow-operation")), "1")?;
    invoke(&s, "connector_fetch", json!({"event_id":event_id})).await?;
    assert!(
        s.provider()?
            .requests()
            .iter()
            .any(|r| r.to_string().contains("upstream_deadline_exceeded")),
        "host abandoned connector operation instead of returning its error"
    );
    let deadline = fs::read_to_string(data(&s).join(format!("{id}-deadline")))?;
    assert!(
        deadline.parse::<u64>().unwrap() > 10000,
        "missing shared host deadline"
    );
    s.finish().await
}
