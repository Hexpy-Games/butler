use super::*;

pub(super) async fn wait_imported_turn(d: &Deployed, turn: &str) -> Result<(), HarnessError> {
    let cursor =
        d.s.sandbox
            .data
            .join(format!("config/computers/{}.transcripts.json", d.id));
    let deadline = Instant::now() + Duration::from_secs(90);
    while !cursor.exists() {
        assert!(Instant::now() < deadline, "transcript cursor is missing");
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
    let db = butler_platform::sqlite::open_with_flags(
        d.s.sandbox.data.join("runtime/conversation-store.sqlite"),
        rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY,
    )?;
    loop {
        let imported: bool = db.query_row(
            "SELECT EXISTS(SELECT 1 FROM conversation_turns WHERE id=?1)",
            [turn],
            |row| row.get(0),
        )?;
        if imported {
            return Ok(());
        }
        assert!(Instant::now() < deadline, "turn was not imported");
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
}

pub(super) async fn assert_removed_conversation(
    d: &Deployed,
    chat: &str,
    text: &str,
) -> Result<(), HarnessError> {
    let path = format!("/session-view?session_id={chat}");
    let view = d.s.gw.get(&path).await?;
    assert_eq!(view.status, 200, "{view:?}");
    assert_eq!(view.data()["latest_turn"]["state"], "delivered", "{view:?}");
    let messages = &view.data()["messages"];
    assert_eq!(messages.as_array().map(Vec::len), Some(2));
    assert_eq!(messages[0]["text"], text);
    assert_eq!(messages[1]["text"], "Checked.");
    let listed = d.s.gw.get(&format!("/messages?chat_id={chat}")).await?;
    assert_eq!(listed.status, 200, "{listed:?}");
    assert_eq!(&listed.data()["messages"], messages);
    let refused = d
        .api
        .send(
            Method::POST,
            "/messages",
            Some(json!({"chat_id": chat, "text": "Write again"})),
            &[],
        )
        .await?;
    assert_eq!(refused.status, 409, "{refused:?}");
    assert_eq!(refused.error_code(), Some("computer_removed"));
    let db = butler_platform::sqlite::open_with_flags(
        d.s.sandbox.data.join("app-server/butler-client.sqlite"),
        rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY,
    )?;
    let counts = || {
        db.query_row(
        "SELECT (SELECT COUNT(*) FROM turns WHERE chat_id=?1), (SELECT COUNT(*) FROM messages WHERE chat_id=?1)",
        [chat], |row| Ok((row.get::<_, usize>(0)?, row.get::<_, usize>(1)?)),
    )
    };
    assert_eq!(counts()?, (1, 2));
    let again = d.s.gw.get(&path).await?;
    assert_eq!(again.status, 200, "{again:?}");
    assert_eq!(counts()?, (1, 2));
    Ok(())
}

pub(super) async fn tool_progress(
    d: &Deployed,
    chat: &str,
    turn: &str,
) -> Result<(serde_json::Value, serde_json::Value), HarnessError> {
    let view =
        d.s.gw
            .get(&format!("/session-view?session_id={chat}"))
            .await?;
    assert_eq!(view.status, 200, "{view:?}");
    let latest = &view.data()["latest_turn"];
    assert_eq!(latest["id"], turn);
    let rows = &latest["progress"]["safe_progress_rows"];
    let row = rows
        .as_array()
        .into_iter()
        .flatten()
        .find(|row| row["safe_tool_name"] == "run_command")
        .cloned()
        .unwrap_or_default();
    assert!(row.is_object(), "missing command row: {rows:?}");
    Ok((row["safe_tool_name"].clone(), row["state"].clone()))
}
