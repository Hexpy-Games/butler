use super::*;

#[tokio::test]
async fn epic_delete_bound_chat_drafts_then_live_accept_stays_open() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    let (s, script, server, project, _) =
        setup("EPIC-DELETE-BOUND-DRAFT", Access::AskAlways).await?;
    let epic = create(&s, &project).await?;
    let chat = data(
        s.gw.post(
            &format!("/canon/epics/{}/conversation", epic["id"].as_str().unwrap()),
            json!({}),
        )
        .await?,
        200,
    )["session_id"]
        .as_str()
        .unwrap()
        .to_owned();
    let proposal = draft(&s, &script, &chat, args(&project, &epic)).await?;
    script
        .hold_next
        .store(true, std::sync::atomic::Ordering::SeqCst);
    let reply = s.gw.say(&chat, "An unrelated question").await?;
    tokio::time::timeout(Duration::from_secs(15), script.held.notified())
        .await
        .map_err(|e| HarnessError(e.to_string()))?;
    let turn = s.gw.accepted_turn(&reply).await?;
    let refusal =
        s.gw.post(
            &format!("/canon/proposals/{proposal}"),
            json!({"outcome":"accepted"}),
        )
        .await?;
    assert_eq!(refusal.status, 409, "{}", refusal.text);
    assert_eq!(refusal.body["error"]["code"], "running");
    assert_eq!(read(&s, &proposal).await?["state"], "open");
    script.release.notify_one();
    s.gw.wait_terminal(&chat, &turn, Duration::from_secs(60))
        .await?;
    assert_eq!(accept(&s, &proposal).await?["ok"], true);
    assert_eq!(read(&s, &proposal).await?["state"], "applied");
    server.abort();
    s.finish().await
}

#[tokio::test]
async fn epic_delete_chat_can_decline() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    let (s, script, server, project, chat) =
        setup("EPIC-DELETE-CHAT-DECLINE", Access::AskAlways).await?;
    let epic = create(&s, &project).await?;
    let proposal = draft(&s, &script, &chat, args(&project, &epic)).await?;
    run(&s,&script,&chat,"삭제 취소해",vec![("resolve_ask",json!({"ask_id":format!("canon:{proposal}"),"outcome":"declined","quote":"삭제 취소해"}))]).await?;
    assert_eq!(read(&s, &proposal).await?["state"], "cancelled");
    assert_eq!(asks(&s, &chat).await?["open_count"], 0);
    assert_eq!(
        s.gw.get(&format!("/canon/epics/{}", epic["id"].as_str().unwrap()))
            .await?
            .status,
        200
    );
    server.abort();
    s.finish().await
}

#[tokio::test]
async fn epic_delete_does_not_recreate_hold_for_deleted_chat() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    deleted_chat_panel("canon_hold", false).await
}

#[tokio::test]
async fn epic_delete_does_not_recreate_take_for_deleted_chat() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    deleted_chat_panel("canon_take_here", false).await
}

async fn deleted_chat_panel(kind: &str, missing_other: bool) -> Result<(), HarnessError> {
    let (mut s, _, server, project, chat) =
        setup("EPIC-DELETE-DELETED-CHAT", Access::AskAlways).await?;
    let epic = create(&s, &project).await?;
    let id = epic["id"].as_str().unwrap();
    s.turn(&chat, "Bind chat identity").await?;
    let app =
        butler_platform::sqlite::open(s.sandbox.data.join("app-server/butler-client.sqlite"))?;
    let owner: String = app.query_row(
        "SELECT COALESCE(runtime_session_hint,'butler/app-'||id) FROM chats WHERE id=?1",
        [&chat],
        |r| r.get(0),
    )?;
    let target = if missing_other {
        data(
            s.gw.post("/sessions", json!({"title":"Still here","kind":"chat"}))
                .await?,
            201,
        )["session"]["id"]
            .as_str()
            .unwrap()
            .to_owned()
    } else {
        chat.clone()
    };
    let panel_owner = if missing_other {
        format!("butler/app-{target}")
    } else {
        owner.clone()
    };
    let canon = db(&s)?;
    {
        let payload = json!({"session_id":panel_owner,"other_session_id":owner,"epic_id":id,"epic_title":"삭제할 과제","state":"pending"});
        canon.execute("INSERT INTO canon_intents(op_id,kind,payload_json,state,created_at) VALUES(?1,?1,?2,'applied',0)",rusqlite::params![kind,payload.to_string()])?;
        app.execute("INSERT INTO app_initiated_messages(id,chat_id,kind,source_key,text,payload_json,state,created_at) VALUES(?1,?2,?1,?1,'Pending',?3,'posted','2026-01-01')",rusqlite::params![kind,target,json!({"panel":payload}).to_string()])?;
    }
    assert_eq!(
        s.gw.delete(&format!("/sessions/{chat}?permanent=true"))
            .await?
            .status,
        200
    );
    assert_eq!(delete(&s, &epic, &epic["revision"]).await?.status, 200);
    let deadline = std::time::Instant::now() + Duration::from_secs(15);
    while canon.query_row::<i64,_,_>("SELECT count(*) FROM canon_intents WHERE state='pending' AND kind IN ('canon_hold','canon_take_here')",[],|r|r.get(0))? > 0 {
        assert!(std::time::Instant::now()<deadline,"panel intent for deleted chat remains pending");
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
    assert_eq!(
        app.query_row::<i64, _, _>(
            "SELECT count(*) FROM app_initiated_messages WHERE chat_id=?1",
            [&chat],
            |r| r.get(0)
        )?,
        0
    );
    if missing_other {
        let state: String = app.query_row("SELECT json_extract(payload_json,'$.panel.state') FROM app_initiated_messages WHERE source_key=?1", [kind], |r|r.get(0))?;
        assert_eq!(state, "deleted", "a panel in a surviving chat must settle");
    }
    s.restart().await?;
    assert_eq!(
        app.query_row::<i64, _, _>(
            "SELECT count(*) FROM app_initiated_messages WHERE chat_id=?1",
            [&chat],
            |r| r.get(0)
        )?,
        0
    );
    assert_eq!(canon.query_row::<i64,_,_>("SELECT count(*) FROM canon_intents WHERE state='pending' AND kind IN ('canon_hold','canon_take_here')",[],|r|r.get(0))?,0);
    server.abort();
    s.finish().await
}

#[tokio::test]
async fn epic_delete_skips_take_when_other_chat_was_deleted() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    deleted_chat_panel("canon_take_here", true).await
}

#[tokio::test]
async fn epic_delete_bound_unrelated_turn_has_no_progress_spinner() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    let (s, script, server, project, _) = setup("EPIC-DELETE-PROGRESS", Access::AskAlways).await?;
    let epic = create(&s, &project).await?;
    let id = epic["id"].as_str().unwrap();
    let chat = data(
        s.gw.post(&format!("/canon/epics/{id}/conversation"), json!({}))
            .await?,
        200,
    )["session_id"]
        .as_str()
        .unwrap()
        .to_owned();
    script
        .hold_next
        .store(true, std::sync::atomic::Ordering::SeqCst);
    let reply = s.gw.say(&chat, "Unrelated question").await?;
    tokio::time::timeout(Duration::from_secs(15), script.held.notified())
        .await
        .map_err(|e| HarnessError(e.to_string()))?;
    let turn = s.gw.accepted_turn(&reply).await?;
    let detail = data(s.gw.get(&format!("/canon/epics/{id}")).await?, 200);
    let progress = data(s.gw.get(&format!("/canon/epics/{id}/progress")).await?, 200);
    assert_eq!(detail["running"], false);
    assert_eq!(detail["running"], progress["running"]);
    assert_eq!(detail["delete_blocked"], true);
    let board = data(s.gw.get(&format!("/projects/{project}/canon")).await?, 200);
    let card = board["backlog"]
        .as_array()
        .unwrap()
        .iter()
        .find(|c| c["id"] == id)
        .unwrap();
    assert_eq!(card["running"], false);
    assert_eq!(card["delete_blocked"], true);
    script.release.notify_one();
    s.gw.wait_terminal(&chat, &turn, Duration::from_secs(60))
        .await?;
    server.abort();
    s.finish().await
}

mod requires_e2e_fixtures {
    use super::*;
    #[tokio::test]
    async fn epic_delete_refuses_step_before_turn_admission() -> Result<(), HarnessError> {
        butler_e2e::gate!();
        let (mut s, _, server, project, chat) =
            setup("EPIC-DELETE-BEFORE-ADMISSION", Access::AskAlways).await?;
        let epic = create(&s, &project).await?;
        let id = epic["id"].as_str().unwrap();
        s.agent.terminate().await?;
        let release = s.sandbox.data.join("step-release");
        s.agent
            .launch
            .set_env("BUTLER_E2E_HOLD_POINT", "canon_step_admission");
        s.agent
            .launch
            .set_env("BUTLER_E2E_HOLD_RELEASE", release.to_string_lossy());
        s.gw = s.agent.start_again().await?;
        data(
            s.gw.post(
                &format!("/sessions/{chat}/canon/queue"),
                json!({"op":"start_now","epic_id":id}),
            )
            .await?,
            200,
        );
        let deadline = std::time::Instant::now() + Duration::from_secs(15);
        while !release.with_extension("held").exists() {
            assert!(std::time::Instant::now() < deadline);
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
        let canon = db(&s)?;
        assert_eq!(canon.query_row::<i64,_,_>("SELECT count(*) FROM btcc_turns WHERE semantic_state IN ('admitted','delivery_committed')",[],|r|r.get(0))?,0);
        let refusal = delete(&s, &epic, &epic["revision"]).await?;
        assert_eq!(refusal.status, 409);
        assert_eq!(refusal.body["error"]["code"], "running");
        std::fs::write(release, b"continue")?;
        let events = LiveEvents::subscribe(&s.gw, 0).await?;
        events
            .wait_for(Duration::from_secs(15), |e| {
                e["type"] == "message.updated"
                    && e["payload"]["message"]["initiated"]["epic_id"] == id
                    && e["payload"]["message"]["status"] == "delivered"
            })
            .await?;
        for turn in s.gw.turns(&chat).await? {
            s.gw.wait_terminal(&chat, turn["id"].as_str().unwrap(), Duration::from_secs(60))
                .await?;
        }
        wait_receipt(&s, id).await?;
        assert_eq!(delete(&s, &epic, &epic["revision"]).await?.status, 200);
        server.abort();
        s.finish().await
    }
}

#[tokio::test]
async fn epic_delete_upgrade_reconciles_delivered_queue_without_work() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    let (mut s, _, server, project, chat) =
        setup("EPIC-DELETE-QUEUE-UPGRADE", Access::AskAlways).await?;
    let epic = create(&s, &project).await?;
    let id = epic["id"].as_str().unwrap();
    let events = LiveEvents::subscribe(&s.gw, 0).await?;
    data(
        s.gw.post(
            &format!("/sessions/{chat}/canon/queue"),
            json!({"op":"start_now","epic_id":id}),
        )
        .await?,
        200,
    );
    events
        .wait_for(Duration::from_secs(15), |e| {
            e["type"] == "message.updated"
                && e["payload"]["message"]["initiated"]["epic_id"] == id
                && e["payload"]["message"]["status"] == "delivered"
        })
        .await?;
    for turn in s.gw.turns(&chat).await? {
        s.gw.wait_terminal(&chat, turn["id"].as_str().unwrap(), Duration::from_secs(60))
            .await?;
    }
    s.agent.terminate().await?;
    let canon = db(&s)?;
    assert_eq!(canon.query_row::<i64,_,_>("SELECT count(*) FROM canon_session_queue WHERE epic_id=?1 AND turn_ended_at IS NOT NULL",[id],|r|r.get(0))?,1);
    canon.execute_batch("ALTER TABLE canon_session_queue DROP COLUMN turn_ended_at")?;
    s.gw = s.agent.start_again().await?;
    let deadline = std::time::Instant::now() + Duration::from_secs(15);
    while canon.query_row::<i64, _, _>(
        "SELECT count(*) FROM canon_session_queue WHERE epic_id=?1 AND turn_ended_at IS NOT NULL",
        [id],
        |r| r.get(0),
    )? == 0
    {
        assert!(
            std::time::Instant::now() < deadline,
            "legacy terminal turn was not reconciled"
        );
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
    assert_eq!(delete(&s, &epic, &epic["revision"]).await?.status, 200);
    server.abort();
    s.finish().await
}

#[tokio::test]
async fn epic_delete_does_not_replay_settled_panels_without_pending_answer()
-> Result<(), HarnessError> {
    butler_e2e::gate!();
    let (s, _, server, project, chat) =
        setup("EPIC-DELETE-SETTLED-HISTORY", Access::AskAlways).await?;
    let epic = create(&s, &project).await?;
    let id = epic["id"].as_str().unwrap();
    let canon = db(&s)?;
    for (kind, state) in [("canon_hold", "continued"), ("canon_take_here", "taken")] {
        canon.execute("INSERT INTO canon_intents(op_id,kind,payload_json,state,created_at) VALUES(?1,?1,?2,'applied',0)",rusqlite::params![kind,json!({"session_id":format!("butler/app-{chat}"),"other_session_id":format!("butler/app-{chat}"),"epic_id":id,"epic_title":"Old decision","state":state}).to_string()])?;
    }
    assert_eq!(delete(&s, &epic, &epic["revision"]).await?.status, 200);
    assert_eq!(canon.query_row::<i64,_,_>("SELECT count(*) FROM canon_intents WHERE json_extract(payload_json,'$.epic_id')=?1 AND kind IN ('canon_hold','canon_take_here')",[id],|r|r.get(0))?,0);
    server.abort();
    s.finish().await
}

#[tokio::test]
async fn epic_delete_first_panel_after_deletion_has_terminal_text() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    let (mut s, _, server, project, chat) =
        setup("EPIC-DELETE-FIRST-PANEL", Access::AskAlways).await?;
    let epic = create(&s, &project).await?;
    let id = epic["id"].as_str().unwrap();
    assert_eq!(delete(&s, &epic, &epic["revision"]).await?.status, 200);
    s.agent.terminate().await?;
    let canon = db(&s)?;
    canon.execute("INSERT INTO canon_intents(op_id,kind,payload_json,state,created_at) VALUES('late-hold','canon_hold',?1,'pending',0)",[json!({"session_id":format!("butler/app-{chat}"),"epic_id":id,"epic_title":"삭제할 과제","state":"pending"}).to_string()])?;
    s.gw = s.agent.start_again().await?;
    let app =
        butler_platform::sqlite::open(s.sandbox.data.join("app-server/butler-client.sqlite"))?;
    let deadline = std::time::Instant::now() + Duration::from_secs(15);
    while app.query_row::<i64, _, _>(
        "SELECT count(*) FROM app_initiated_messages WHERE source_key='late-hold'",
        [],
        |r| r.get(0),
    )? == 0
    {
        assert!(std::time::Instant::now() < deadline);
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
    panels::wait_settled(&app, "late-hold").await?;
    let text: String = app.query_row(
        "SELECT text FROM app_initiated_messages WHERE source_key='late-hold'",
        [],
        |r| r.get(0),
    )?;
    assert!(
        !text.contains("막혀") && !text.contains("blocked"),
        "{text}"
    );
    server.abort();
    s.finish().await
}
