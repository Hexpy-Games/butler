use super::*;

#[tokio::test]
async fn epic_delete_terminal_receipt_emits_board_refresh() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    let (mut s, script, server, project, chat) =
        setup("EPIC-DELETE-TERMINAL-EVENT", Access::AskAlways).await?;
    let epic = create(&s, &project).await?;
    let id = epic["id"].as_str().unwrap();
    let canon = db(&s)?;
    // Capture only the receipt's event: earlier BTCC commits are deliberately
    // insufficient to tell the board that deletion has become available.
    canon.execute_batch("CREATE TRIGGER hold_receipt BEFORE UPDATE OF turn_ended_at ON canon_session_queue WHEN NEW.turn_ended_at IS NOT NULL AND OLD.turn_ended_at IS NULL BEGIN SELECT RAISE(ABORT,'receipt unavailable'); END;")?;
    script
        .hold_next
        .store(true, std::sync::atomic::Ordering::SeqCst);
    data(
        s.gw.post(
            &format!("/sessions/{chat}/canon/queue"),
            json!({"op":"start_now","epic_id":id}),
        )
        .await?,
        200,
    );
    tokio::time::timeout(Duration::from_secs(15), script.held.notified())
        .await
        .map_err(|e| HarnessError(e.to_string()))?;
    script.release.notify_one();
    let deadline = std::time::Instant::now() + Duration::from_secs(15);
    loop {
        let turns = s.gw.turns(&chat).await?;
        if let Some(turn) = turns.first() {
            s.gw.wait_terminal(&chat, turn["id"].as_str().unwrap(), Duration::from_secs(60))
                .await?;
            break;
        }
        assert!(std::time::Instant::now() < deadline);
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
    let before = data(s.gw.get(&format!("/projects/{project}/canon")).await?, 200);
    assert_eq!(before["backlog"][0]["delete_blocked"], true);
    let app =
        butler_platform::sqlite::open(s.sandbox.data.join("app-server/butler-client.sqlite"))?;
    let cursor: u64 = app.query_row("SELECT COALESCE(MAX(id),0) FROM events", [], |r| r.get(0))?;
    let live = LiveEvents::subscribe(&s.gw, cursor).await?;
    canon.execute_batch("DROP TRIGGER hold_receipt")?;
    live.wait_for(Duration::from_secs(15), |e| {
        e["type"] == "canon.progress_changed" && e["payload"]["epic_id"] == id
    })
    .await?;
    let board = data(s.gw.get(&format!("/projects/{project}/canon")).await?, 200);
    assert_eq!(
        board["backlog"]
            .as_array()
            .unwrap()
            .iter()
            .find(|e| e["id"] == id)
            .unwrap()["delete_blocked"],
        false
    );
    let before: i64 = canon.query_row("SELECT count(*) FROM canon_events WHERE topic='canon.progress_changed' AND json_extract(payload_json,'$.epic_id')=?1",[id],|r|r.get(0))?;
    s.restart().await?;
    assert_eq!(canon.query_row::<i64,_,_>("SELECT count(*) FROM canon_events WHERE topic='canon.progress_changed' AND json_extract(payload_json,'$.epic_id')=?1",[id],|r|r.get(0))?,before,"receipt replay must not emit on a no-op");
    server.abort();
    s.finish().await
}

#[tokio::test]
async fn epic_delete_cancellation_receipt_refreshes_board_once() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    let (mut s, _, server, project, chat) =
        setup("EPIC-DELETE-CANCELLATION-EVENT", Access::AskAlways).await?;
    let epic = create(&s, &project).await?;
    let id = epic["id"].as_str().unwrap();
    let canon = db(&s)?;
    canon.execute(
        "INSERT INTO canon_step_cancellations VALUES('source-step',?1,'missing-owner')",
        [id],
    )?;
    let board = data(s.gw.get(&format!("/projects/{project}/canon")).await?, 200);
    assert_eq!(board["backlog"][0]["delete_blocked"], true);
    let app =
        butler_platform::sqlite::open(s.sandbox.data.join("app-server/butler-client.sqlite"))?;
    let cursor: u64 = app.query_row("SELECT COALESCE(MAX(id),0) FROM events", [], |r| r.get(0))?;
    let live = LiveEvents::subscribe(&s.gw, cursor).await?;
    let other = create(&s, &project).await?;
    data(
        s.gw.post(
            &format!("/sessions/{chat}/canon/queue"),
            json!({"op":"start_now","epic_id":other["id"]}),
        )
        .await?,
        200,
    );
    live.wait_for(Duration::from_secs(15), |e| {
        e["type"] == "canon.progress_changed" && e["payload"]["epic_id"] == id
    })
    .await?;
    let board = data(s.gw.get(&format!("/projects/{project}/canon")).await?, 200);
    assert_eq!(
        board["backlog"]
            .as_array()
            .unwrap()
            .iter()
            .find(|e| e["id"] == id)
            .unwrap()["delete_blocked"],
        false
    );
    let before: i64 = canon.query_row("SELECT count(*) FROM canon_events WHERE topic='canon.progress_changed' AND json_extract(payload_json,'$.epic_id')=?1",[id],|r|r.get(0))?;
    s.restart().await?;
    assert_eq!(canon.query_row::<i64,_,_>("SELECT count(*) FROM canon_events WHERE topic='canon.progress_changed' AND json_extract(payload_json,'$.epic_id')=?1",[id],|r|r.get(0))?,before);
    server.abort();
    s.finish().await
}
