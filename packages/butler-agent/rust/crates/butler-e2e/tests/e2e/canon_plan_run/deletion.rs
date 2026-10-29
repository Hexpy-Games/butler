use super::*;
#[tokio::test]
async fn session_delete_removes_queue_and_bindings() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    let (s, script, server, first, chat) =
        crate::canon_link::setup("CB-DELETE", false, false).await?;
    script.release();
    let started = s.gw.say(&chat, "Process the release epic").await?;
    s.gw.wait_terminal(
        &chat,
        &s.gw.accepted_turn(&started).await?,
        std::time::Duration::from_secs(60),
    )
    .await?;
    let db = rusqlite::Connection::open(s.sandbox.data.join("agent-runtime/btcc.sqlite"))?;
    let links: i64 = db.query_row("SELECT count(*) FROM canon_epic_work_links", [], |r| {
        r.get(0)
    })?;
    assert_eq!(links, 1);
    drop(db);
    script
        .quick
        .store(true, std::sync::atomic::Ordering::SeqCst);
    let (plan, _) = plan(&s, &script, &first).await?;
    data(
        s.gw.post(
            &format!("/sessions/{chat}/canon/queue"),
            json!({"op":"plan_run","plan_id":plan}),
        )
        .await?,
        200,
    );
    data(
        s.gw.patch(&format!("/sessions/{chat}"), json!({"archived":true}))
            .await?,
        200,
    );
    let view = data(
        s.gw.get(&format!("/sessions/{chat}/canon/queue")).await?,
        200,
    );
    assert_eq!(
        view["chains"].as_array().unwrap().len(),
        1,
        "archive retains queue"
    );
    let other = data(
        s.gw.post("/sessions", json!({"title":"Other","kind":"chat"}))
            .await?,
        201,
    );
    let other = other["session"]["id"].as_str().unwrap();
    let offer = uuid::Uuid::new_v4().to_string();
    let app = rusqlite::Connection::open(s.sandbox.data.join("app-server/butler-client.sqlite"))?;
    app.execute_batch("CREATE TRIGGER reject_offer BEFORE INSERT ON app_initiated_messages WHEN NEW.kind='canon_take_here' BEGIN SELECT RAISE(ABORT,'projection unavailable'); END;")?;
    let db = rusqlite::Connection::open(s.sandbox.data.join("agent-runtime/btcc.sqlite"))?;
    db.execute("INSERT INTO canon_intents(op_id,kind,payload_json,state,revision,created_at) VALUES(?1,'canon_take_here',?2,'pending',1,0)", rusqlite::params![offer,json!({"session_id":butler_gateway::gateway::app_session_hint(other),"other_session_id":butler_gateway::gateway::app_session_hint(&chat),"epic_id":first,"epic_title":"Release","state":"pending"}).to_string()])?;
    data(
        s.gw.delete(&format!("/sessions/{chat}?permanent=true"))
            .await?,
        200,
    );
    app.execute_batch("DROP TRIGGER reject_offer")?;
    assert_eq!(
        db.query_row::<String, _, _>(
            "SELECT state FROM canon_intents WHERE op_id=?1",
            [&offer],
            |r| r.get(0)
        )?,
        "applied"
    );
    let db = rusqlite::Connection::open(s.sandbox.data.join("agent-runtime/btcc.sqlite"))?;
    assert_eq!(
        db.query_row::<i64, _, _>("SELECT count(*) FROM canon_epic_work_links", [], |r| r
            .get(0))?,
        links
    );
    for table in ["canon_session_queue", "canon_session_epics"] {
        assert_eq!(
            db.query_row::<i64, _, _>(&format!("SELECT count(*) FROM {table}"), [], |r| r.get(0))?,
            0
        );
    }
    assert_eq!(
        db.query_row::<i64, _, _>(
            "SELECT count(*) FROM canon_intents WHERE op_id=?1 AND state='applied'",
            [format!("session-delete:{chat}")],
            |r| r.get(0)
        )?,
        1
    );
    drop(db);
    s.finish().await?;
    server.abort();
    Ok(())
}
mod requires_e2e_fixtures {
    use super::*;
    #[tokio::test]
    async fn session_delete_orphan_reconcile() -> Result<(), HarnessError> {
        butler_e2e::gate!();
        let (mut s, script, server, first, chat) =
            crate::canon_link::setup("CB-ORPHAN", false, false).await?;
        script
            .quick
            .store(true, std::sync::atomic::Ordering::SeqCst);
        data(
            s.gw.post(
                &format!("/sessions/{chat}/canon/queue"),
                json!({"op":"start_now","epic_id":first}),
            )
            .await?,
            200,
        );
        s.agent.terminate().await?;
        let db = rusqlite::Connection::open(s.sandbox.data.join("agent-runtime/btcc.sqlite"))?;
        // The HTTP hold does not park background outbox replay. Keep every
        // Canon delete before its commit until we have injected the crash.
        db.execute_batch("CREATE TRIGGER refuse_delete BEFORE DELETE ON canon_session_epics BEGIN SELECT RAISE(ABORT,'crash boundary'); END;")?;
        let release = s.sandbox.data.join("delete-release");
        s.agent
            .launch
            .set_env("BUTLER_E2E_HOLD_POINT", "canon_session_delete");
        s.agent
            .launch
            .set_env("BUTLER_E2E_HOLD_RELEASE", release.to_string_lossy());
        s.gw = s.agent.start_again().await?;
        let gw = s.gw.clone();
        let target = chat.clone();
        let deleting = tokio::spawn(async move {
            gw.delete(&format!("/sessions/{target}?permanent=true"))
                .await
        });
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(30);
        while !release.with_extension("held").exists() {
            assert!(
                std::time::Instant::now() < deadline,
                "delete commit barrier was not reached"
            );
            tokio::time::sleep(std::time::Duration::from_millis(20)).await;
        }
        assert!(
            db.query_row::<i64, _, _>("SELECT count(*) FROM canon_session_epics", [], |r| r
                .get(0))?
                > 0
        );
        let app =
            rusqlite::Connection::open(s.sandbox.data.join("app-server/butler-client.sqlite"))?;
        assert_eq!(
            app.query_row::<i64, _, _>("SELECT count(*) FROM chats WHERE id=?1", [&chat], |r| r
                .get(0))?,
            0,
            "App deletion must be committed before the crash"
        );
        assert_eq!(
            app.query_row::<i64, _, _>(
                "SELECT count(*) FROM app_canon_session_deletes WHERE op_id=?1",
                [format!("session-delete:{chat}")],
                |r| r.get(0)
            )?,
            1,
            "Canon deletion must remain pending before the crash"
        );
        drop(app);
        s.agent.kill9()?;
        let _ = deleting.await;
        db.execute_batch("DROP TRIGGER refuse_delete")?;
        std::fs::write(&release, b"continue")?;
        s.gw = s.agent.start_again().await?;
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(30);
        loop {
            if db.query_row::<i64, _, _>("SELECT count(*) FROM canon_session_epics", [], |r| {
                r.get(0)
            })? == 0
            {
                break;
            }
            assert!(std::time::Instant::now() < deadline);
            tokio::time::sleep(std::time::Duration::from_millis(20)).await;
        }
        assert_eq!(
            db.query_row::<i64, _, _>("SELECT count(*) FROM canon_session_queue", [], |r| r
                .get(0))?,
            0
        );
        drop(db);
        drop(script);
        s.finish().await?;
        server.abort();
        Ok(())
    }
}
