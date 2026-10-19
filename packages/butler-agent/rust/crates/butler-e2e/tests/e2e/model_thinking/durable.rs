use super::*;

pub(super) fn assert_chunks(s: &Scenario, expected: i64) -> Result<(), HarnessError> {
    let db = rusqlite::Connection::open_with_flags(
        s.sandbox.data.join("app-server/butler-client.sqlite"),
        rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY,
    )?;
    let count: i64 = db.query_row(
        "SELECT COUNT(*) FROM app_operation_output_chunks",
        [],
        |r| r.get(0),
    )?;
    assert_eq!(count, expected);
    Ok(())
}

pub(super) async fn assert_saved(
    s: &Scenario,
    turn: &str,
    expected: &str,
) -> Result<(), HarnessError> {
    let export = s.gw.get("/transcript-export?session_id=general").await?;
    assert_eq!(export.status, 200);
    assert!(!export.text.contains(FIRST));
    let messages = s.gw.messages("general").await?;
    let rows: Vec<_> = messages
        .iter()
        .flat_map(|m| m["turn_activity_rows"].as_array().into_iter().flatten())
        .collect();
    let thinking: Vec<_> = rows
        .iter()
        .filter(|r| r["thinking_title"].is_string())
        .collect();
    assert_eq!(thinking.len(), 1, "one summary round: {messages:?}");
    let row = thinking[0];
    assert_eq!(row["thinking_title"], SECOND);
    if let Some(tool) = rows
        .iter()
        .position(|r| r["bridge_phase"] == "btcc_operation")
    {
        assert!(
            rows.iter()
                .position(|r| r["thinking_title"].is_string())
                .unwrap()
                < tool,
            "round precedes its tool in history"
        );
    }
    let call = row["tool_call_id"].as_str().unwrap();
    let result = row["tool_result_id"].as_str().unwrap();
    let output =
        s.gw.get(&format!(
            "/turns/{turn}/operations/{call}/output?result_id={result}&offset=0"
        ))
        .await?;
    assert_eq!(output.status, 200, "{}", output.text);
    assert_eq!(output.data()["content"], expected);
    assert_eq!(output.data()["complete"], true);
    // The tool result is a separate output; only one thinking body was written.
    let db = rusqlite::Connection::open_with_flags(
        s.sandbox.data.join("app-server/butler-client.sqlite"),
        rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY,
    )?;
    let (count, bytes): (i64, i64) = db.query_row(
        "SELECT COUNT(*), COALESCE(SUM(LENGTH(content_base64)),0) FROM app_operation_output_chunks WHERE request_id=?1",
        [call], |r| Ok((r.get(0)?,r.get(1)?)))?;
    assert_eq!(count, 1);
    let btcc = rusqlite::Connection::open_with_flags(
        s.sandbox.data.join("agent-runtime/btcc.sqlite"),
        rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY,
    )?;
    let (completed, chunks, logical_bytes): (i64,i64,i64) = btcc.query_row(
        "SELECT SUM(json_extract(event_json,'$.kind')='tool.completed'), SUM(json_extract(event_json,'$.kind')='operation.output.chunk'), SUM(LENGTH(event_json)) FROM btcc_progress_events WHERE json_extract(event_json,'$.payload.toolCallId')=?1 OR json_extract(event_json,'$.payload.requestId')=?1",
        [call], |r| Ok((r.get(0)?,r.get(1)?,r.get(2)?)))?;
    assert_eq!(
        (completed, chunks),
        (1, 1),
        "one round-end record, no delta writes"
    );
    let readable: i64 = btcc.query_row(
        "SELECT COUNT(*) FROM btcc_guided_tool_calls WHERE call_id=?1",
        [call],
        |r| r.get(0),
    )?;
    assert_eq!(
        readable, 0,
        "model read_operation_result cannot address display summaries"
    );
    let memory_source = rusqlite::Connection::open_with_flags(
        s.sandbox.data.join("runtime/conversation-store.sqlite"),
        rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY,
    )?;
    let copies: i64 = memory_source.query_row(
        "SELECT COUNT(*) FROM conversation_parts WHERE kind='text' AND instr(content_json,?1)>0",
        [FIRST],
        |r| r.get(0),
    )?;
    assert_eq!(
        copies, 0,
        "canonical memory source excludes display summaries"
    );
    eprintln!(
        "round BTCC lifecycle+chunk JSON={logical_bytes} B; completed={completed}, chunks={chunks}; idle summary delta=0"
    );
    for message in &messages {
        assert!(!message["text"].to_string().contains(FIRST));
    }
    let fts: i64 = db.query_row(
        "SELECT COUNT(*) FROM messages_fts WHERE messages_fts MATCH ?1",
        ["\"Planning the search\""],
        |r| r.get(0),
    )?;
    assert_eq!(fts, 0);
    let before = thinking_writes(s)?;
    tokio::time::sleep(Duration::from_millis(1200)).await;
    assert_eq!(
        before,
        thinking_writes(s)?,
        "idle summary writes must be zero"
    );
    eprintln!(
        "thinking round: body={} B, base64={} B, chunks={count}",
        expected.len(),
        bytes
    );
    Ok(())
}

fn thinking_writes(s: &Scenario) -> Result<(i64, i64), HarnessError> {
    let db = rusqlite::Connection::open_with_flags(
        s.sandbox.data.join("agent-runtime/btcc.sqlite"),
        rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY,
    )?;
    Ok(db.query_row("SELECT COUNT(*), COALESCE(SUM(LENGTH(event_json)),0) FROM btcc_progress_events WHERE event_json LIKE '%thinkingTitle%' OR event_json LIKE '%operation.output.chunk%'", [], |r| Ok((r.get(0)?, r.get(1)?)))?)
}

pub(super) async fn two_rounds() -> Result<(), HarnessError> {
    let (s, stub, _server) = setup("google", false).await?;
    stub.final_summary
        .store(true, std::sync::atomic::Ordering::Relaxed);
    s.gw.patch("/settings", json!({"show_thinking":true}))
        .await?;
    stub.gate.notify_one();
    stub.finish_gate.notify_one();
    let (_, turn) = s.turn("general", "Reply briefly.").await?;
    assert_eq!(turn["state"], "delivered");
    let messages = s.gw.messages("general").await?;
    let rows: Vec<_> = messages
        .iter()
        .flat_map(|m| m["turn_activity_rows"].as_array().into_iter().flatten())
        .collect();
    let ordered: Vec<_> = rows
        .iter()
        .filter(|r| r["thinking_title"].is_string() || r["bridge_phase"] == "btcc_operation")
        .collect();
    assert_eq!(ordered.len(), 3, "{rows:?}");
    assert_eq!(ordered[0]["thinking_title"], SECOND);
    assert_eq!(ordered[1]["bridge_phase"], "btcc_operation");
    assert_eq!(ordered[2]["thinking_title"], "Finishing the answer");
    for (row, expected) in [
        (
            ordered[0],
            format!("**{FIRST}**\nDetails.\n**{SECOND}**\nMore details.\n"),
        ),
        (
            ordered[2],
            "**Finishing the answer**\nFinal details.\n".into(),
        ),
    ] {
        let output =
            s.gw.operation_output(
                turn["turn_id"]
                    .as_str()
                    .or_else(|| turn["id"].as_str())
                    .unwrap(),
                row,
            )
            .await?;
        assert_eq!(output, expected);
        let db = rusqlite::Connection::open_with_flags(
            s.sandbox.data.join("app-server/butler-client.sqlite"),
            rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY,
        )?;
        let count: i64 = db.query_row(
            "SELECT COUNT(*) FROM app_operation_output_chunks WHERE request_id=?1",
            [row["tool_call_id"].as_str().unwrap()],
            |r| r.get(0),
        )?;
        assert_eq!(count, 1);
    }
    s.finish().await
}
