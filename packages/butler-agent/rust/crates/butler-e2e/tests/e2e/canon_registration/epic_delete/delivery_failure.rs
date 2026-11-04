use super::*;

#[tokio::test]
async fn epic_delete_dispatch_failure_releases_queued_step() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    let (s, script, server, project, chat) =
        setup("EPIC-DELETE-DISPATCH-FAILURE", Access::AskAlways).await?;
    let epic = create(&s, &project).await?;
    let id = epic["id"].as_str().unwrap();
    script
        .hold_next
        .store(true, std::sync::atomic::Ordering::SeqCst);
    let reply = s.gw.say(&chat, "Keep this turn busy").await?;
    tokio::time::timeout(Duration::from_secs(15), script.held.notified())
        .await
        .map_err(|e| HarnessError(e.to_string()))?;
    let turn = s.gw.accepted_turn(&reply).await?;
    data(
        s.gw.post(
            &format!("/sessions/{chat}/canon/queue"),
            json!({"op":"start_now","epic_id":id}),
        )
        .await?,
        200,
    );
    let app =
        butler_platform::sqlite::open(s.sandbox.data.join("app-server/butler-client.sqlite"))?;
    let deadline = std::time::Instant::now() + Duration::from_secs(15);
    loop {
        let changed = app.execute("UPDATE session_queued_messages SET control_resolution_json='{}' WHERE chat_id=?1 AND state='queued'", [&chat])?;
        if changed == 1 {
            break;
        }
        assert!(std::time::Instant::now() < deadline, "step was not queued");
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
    script.release.notify_one();
    s.gw.wait_terminal(&chat, &turn, Duration::from_secs(60))
        .await?;
    let deadline = std::time::Instant::now() + Duration::from_secs(15);
    loop {
        let failed: bool = app.query_row("SELECT EXISTS(SELECT 1 FROM session_queued_messages WHERE chat_id=?1 AND state='failed' AND safe_error_code='turn_control_resolution_invalid')", [&chat], |r| r.get(0))?;
        if failed {
            break;
        }
        assert!(
            std::time::Instant::now() < deadline,
            "dispatch did not fail"
        );
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
    wait_receipt(&s, id).await?;
    assert_eq!(
        s.gw.turns(&chat).await?.len(),
        1,
        "failed dispatch creates no turn"
    );
    assert_failed(&s, id)?;
    assert_eq!(delete(&s, &epic, &epic["revision"]).await?.status, 200);
    server.abort();
    s.finish().await
}

#[tokio::test]
async fn epic_delete_startup_recovers_failed_initiated_receipt() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    recover(false).await
}

#[tokio::test]
async fn epic_delete_startup_recovers_failed_queued_receipt() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    recover(true).await
}

async fn recover(queued: bool) -> Result<(), HarnessError> {
    let (mut s, _, server, project, chat) =
        setup("EPIC-DELETE-LOST-FAILURE", Access::AskAlways).await?;
    let epic = create(&s, &project).await?;
    let id = epic["id"].as_str().unwrap();
    s.agent.terminate().await?;
    let owner = format!("butler/app-{chat}");
    let canon = db(&s)?;
    canon.execute(
        "INSERT INTO canon_session_queue_chains VALUES(?1,'chain',NULL)",
        [&owner],
    )?;
    canon.execute("INSERT INTO canon_session_queue(session_id,epic_id,chain_id,step_index,stack_position,state,origin,step_op_id,started_at) VALUES(?1,?2,'chain',0,0,'running','detach','lost-failure',0)", rusqlite::params![owner,id])?;
    let app =
        butler_platform::sqlite::open(s.sandbox.data.join("app-server/butler-client.sqlite"))?;
    app.execute("INSERT INTO app_initiated_messages(id,chat_id,kind,source_key,text,payload_json,state,message_id,created_at) VALUES('lost-step',?1,'canon_step','lost-failure','Step',?2,?3,'lost-message','2026-01-01')", rusqlite::params![chat,json!({"session_id":owner,"epic_id":id}).to_string(),if queued {"posted"} else {"failed"}])?;
    if queued {
        app.execute("INSERT INTO session_queued_messages(id,chat_id,text,client_message_id,controls_json,attachments_json,state,created_at,updated_at) VALUES('lost-queued',?1,'Step','lost-message','{}','[]','failed','2026-01-01','2026-01-01')", [&chat])?;
    }
    s.gw = s.agent.start_again().await?;
    wait_receipt(&s, id).await?;
    assert_failed(&s, id)?;
    assert_eq!(s.gw.turns(&chat).await?, [] as [Value; 0]);
    let before: i64 = canon.query_row("SELECT count(*) FROM canon_events WHERE topic='canon.progress_changed' AND json_extract(payload_json,'$.epic_id')=?1", [id], |r| r.get(0))?;
    s.restart().await?;
    assert_eq!(canon.query_row::<i64,_,_>("SELECT count(*) FROM canon_events WHERE topic='canon.progress_changed' AND json_extract(payload_json,'$.epic_id')=?1", [id], |r| r.get(0))?, before, "reconciliation must be idempotent");
    assert_eq!(delete(&s, &epic, &epic["revision"]).await?.status, 200);
    server.abort();
    s.finish().await
}

fn assert_failed(s: &Scenario, id: &str) -> Result<(), HarnessError> {
    let row: (String, String) = db(s)?.query_row(
        "SELECT state,hold_reason FROM canon_session_queue WHERE epic_id=?1",
        [id],
        |r| Ok((r.get(0)?, r.get(1)?)),
    )?;
    assert_eq!(row, ("running".into(), "failed".into()));
    Ok(())
}
