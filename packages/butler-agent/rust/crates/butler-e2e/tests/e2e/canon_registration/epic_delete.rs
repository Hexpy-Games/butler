//! Epic deletion uses the same transaction for HTTP and approved chat drafts.
use super::*;

async fn create(s: &Scenario, project: &str) -> Result<Value, HarnessError> {
    Ok(data(
        s.gw.post(
            &format!("/projects/{project}/canon/epics"),
            json!({"title":"삭제할 과제","description":"Keep conversations"}),
        )
        .await?,
        201,
    ))
}
async fn delete(s: &Scenario, epic: &Value, revision: &Value) -> Result<Reply, HarnessError> {
    s.gw.send(
        reqwest::Method::DELETE,
        &format!("/canon/epics/{}", epic["id"].as_str().unwrap()),
        Some(json!({"expected_revision":revision}).to_string()),
    )
    .await
}
fn args(project: &str, epic: &Value) -> Value {
    json!({"project_id":project,"summary":"과제 삭제","changes":[{"op":"epic.delete","id":epic["id"],"expected_revision":epic["revision"]}]})
}
fn db(s: &Scenario) -> Result<butler_platform::sqlite::Connection, HarnessError> {
    Ok(butler_platform::sqlite::open(
        s.sandbox.data.join("agent-runtime/btcc.sqlite"),
    )?)
}
fn count(db: &rusqlite::Connection, table: &str, id: &str) -> i64 {
    db.query_row(
        &format!("SELECT count(*) FROM {table} WHERE epic_id=?1"),
        [id],
        |r| r.get(0),
    )
    .unwrap()
}

#[tokio::test]
async fn epic_delete_http_preserves_conversation_specs_and_history_after_restart()
-> Result<(), HarnessError> {
    butler_e2e::gate!();
    let (mut s, _, server, project, _) = setup("EPIC-DELETE-HTTP", Access::AskAlways).await?;
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
    let (_, turn) = s.turn(&chat, "보존할 대화").await?;
    assert_eq!(turn_state(&turn), "delivered");
    let messages = data(
        s.gw.get(&format!("/session-view?session_id={chat}"))
            .await?,
        200,
    );
    assert_ne!(
        messages["messages"].as_array().unwrap().as_slice(),
        [] as [Value; 0]
    );
    let live = LiveEvents::subscribe(&s.gw, 0).await?;
    let space = data(s.gw.get("/navigation").await?, 200);
    assert!(
        !space.to_string().contains(&format!("s:{chat}")),
        "Epic home hidden from ordinary tree"
    );
    let app =
        butler_platform::sqlite::open(s.sandbox.data.join("app-server/butler-client.sqlite"))?;
    app.execute("INSERT INTO app_canon_sidebar_order(project_id,group_key,work_id,position) VALUES(?1,'backlog',?2,'a')",rusqlite::params![project,id])?;
    drop(app);
    let canon = db(&s)?;
    let owner: String = canon.query_row(
        "SELECT session_id FROM canon_session_epics WHERE epic_id=?1",
        [id],
        |r| r.get(0),
    )?;
    canon.execute(
        "INSERT INTO canon_session_queue_chains VALUES(?1,'delete-chain',NULL)",
        [&owner],
    )?;
    canon.execute("INSERT INTO canon_session_queue(session_id,epic_id,chain_id,step_index,stack_position,state,origin) VALUES(?1,?2,'delete-chain',0,0,'held','user_message')", rusqlite::params![owner,id])?;
    let queue = data(
        s.gw.get(&format!("/sessions/{chat}/canon/queue")).await?,
        200,
    );
    data(
        s.gw.post(
            &format!("/sessions/{chat}/canon/queue/edits"),
            json!({"op":"delete","epic_id":id,"expected_graph_revision":queue["graph_revision"]}),
        )
        .await?,
        200,
    );
    assert_eq!(
        s.gw.get(&format!("/canon/epics/{id}")).await?.status,
        200,
        "queue deletion preserves Epic"
    );
    canon.execute(
        "UPDATE canon_session_queue SET state='held' WHERE epic_id=?1",
        [id],
    )?;
    canon.execute("INSERT INTO canon_intents(op_id,kind,payload_json,state,created_at) VALUES('delete-intent','canon_hold',?1,'applied',0)", [json!({"session_id":owner,"epic_id":id}).to_string()])?;
    let app =
        butler_platform::sqlite::open(s.sandbox.data.join("app-server/butler-client.sqlite"))?;
    // Keep cancellation recovery pending while the deletion transaction is faulted.
    app.execute("INSERT INTO app_initiated_messages(id,chat_id,kind,source_key,text,payload_json,state,created_at) VALUES('delete-cancellation-panel',?1,'canon_hold','delete-cancellation','Pending','{}','posted','2026-01-01')",[&chat])?;
    app.execute_batch("CREATE TRIGGER reject_cancellation_receipt BEFORE UPDATE ON app_initiated_messages WHEN OLD.source_key='delete-cancellation' BEGIN SELECT RAISE(ABORT,'projection unavailable'); END;")?;
    app.execute_batch("CREATE TRIGGER reject_pending_step BEFORE INSERT ON app_initiated_messages WHEN NEW.kind='canon_step' BEGIN SELECT RAISE(ABORT,'projection unavailable'); END;")?;
    canon.execute("INSERT INTO canon_intents(op_id,kind,payload_json,state,created_at) VALUES('delete-pending-step','canon_step',?1,'pending',0)",[json!({"session_id":owner,"epic_id":id,"untrusted_content":{"epic_title":"Deleted"}}).to_string()])?;
    drop(app);
    canon.execute(
        "INSERT INTO canon_step_cancellations VALUES('delete-cancellation',?1,?2)",
        rusqlite::params![id, owner],
    )?;
    canon.execute("INSERT INTO canon_spec_nodes(node_id,scope_kind,scope_ref,epic_id,concern_id,visibility,lifecycle,source,created_at,updated_at,created_by) VALUES('delete-spec','project',?1,?2,'User design','canon','draft','local',0,0,'{}')", rusqlite::params![project,id])?;
    let before: i64 =
        canon.query_row("SELECT count(*) FROM btcc_guided_works", [], |r| r.get(0))?;
    let stale = delete(&s, &epic, &json!(-1)).await?;
    assert_eq!(stale.status, 409);
    assert_eq!(count(&canon, "canon_session_epics", id), 1);
    canon.execute_batch("CREATE TRIGGER refuse_epic_delete BEFORE DELETE ON canon_epics BEGIN SELECT RAISE(ABORT,'unavailable'); END;")?;
    assert_eq!(delete(&s, &epic, &epic["revision"]).await?.status, 500);
    for table in [
        "canon_session_queue",
        "canon_session_epics",
        "canon_step_cancellations",
    ] {
        assert_eq!(count(&canon, table, id), 1, "rollback {table}");
    }
    canon.execute_batch("DROP TRIGGER refuse_epic_delete")?;
    assert_eq!(delete(&s, &epic, &epic["revision"]).await?.status, 200);
    for table in [
        "canon_session_queue",
        "canon_session_epics",
        "canon_epic_work_links",
        "canon_epic_tags",
        "canon_step_cancellations",
    ] {
        assert_eq!(count(&canon, table, id), 0, "{table}");
    }
    assert_eq!(
        canon.query_row::<i64, _, _>(
            "SELECT count(*) FROM canon_intents WHERE json_extract(payload_json,'$.epic_id')=?1",
            [id],
            |r| r.get(0)
        )?,
        0
    );
    assert_eq!(
        canon.query_row::<i64, _, _>("SELECT count(*) FROM btcc_guided_works", [], |r| r.get(0))?,
        before
    );
    assert_eq!(
        canon.query_row::<i64, _, _>(
            "SELECT count(*) FROM canon_spec_nodes WHERE node_id='delete-spec' AND epic_id IS NULL",
            [],
            |r| r.get(0)
        )?,
        1
    );
    assert_eq!(
        canon.query_row::<i64, _, _>("SELECT count(*) FROM pragma_foreign_key_check", [], |r| r
            .get(0))?,
        0
    );
    drop(canon);
    live.wait_for(Duration::from_secs(10), |e| {
        e["type"] == "canon.changed" && e["payload"]["id"] == id && e["payload"]["deleted"] == true
    })
    .await?;
    let space = data(s.gw.get("/navigation").await?, 200);
    assert!(
        space.to_string().contains(&format!("s:{chat}")),
        "conversation returns to ordinary tree"
    );
    let app =
        butler_platform::sqlite::open(s.sandbox.data.join("app-server/butler-client.sqlite"))?;
    assert_eq!(count(&app, "app_canon_conversations", id), 0);
    assert_eq!(
        app.query_row::<i64, _, _>(
            "SELECT count(*) FROM app_canon_sidebar_order WHERE work_id=?1",
            [id],
            |r| r.get(0)
        )?,
        0
    );
    app.execute_batch("DROP TRIGGER reject_pending_step; DROP TRIGGER reject_cancellation_receipt; DELETE FROM app_initiated_messages WHERE id='delete-cancellation-panel';")?;
    drop(app);
    s.restart().await?;
    assert_eq!(s.gw.get(&format!("/canon/epics/{id}")).await?.status, 404);
    let after = data(
        s.gw.get(&format!("/session-view?session_id={chat}"))
            .await?,
        200,
    );
    assert_eq!(after["messages"], messages["messages"]);
    let space = data(s.gw.get("/navigation").await?, 200);
    assert!(space.to_string().contains(&format!("s:{chat}")));
    let navigation = data(s.gw.get("/navigation").await?, 200);
    assert!(
        navigation.to_string().contains(&chat),
        "conversation remains listed"
    );
    server.abort();
    s.finish().await
}

#[tokio::test]
async fn epic_delete_chat_approval_rejection_stale_missing_and_atomic_batch()
-> Result<(), HarnessError> {
    butler_e2e::gate!();
    let (mut s, script, server, project, chat) =
        setup("EPIC-DELETE-CHAT", Access::AskAlways).await?;
    let epic = create(&s, &project).await?;
    let path = format!("/canon/epics/{}", epic["id"].as_str().unwrap());
    let id = draft(&s, &script, &chat, args(&project, &epic)).await?;
    assert!(
        read(&s, &id).await?["target_label"]
            .as_str()
            .unwrap()
            .contains("삭제할 과제")
    );
    assert_eq!(s.gw.get(&path).await?.status, 200);
    data(
        s.gw.post(
            &format!("/canon/proposals/{id}"),
            json!({"outcome":"declined"}),
        )
        .await?,
        200,
    );
    assert_eq!(s.gw.get(&path).await?.status, 200);
    let id = draft(&s, &script, &chat, args(&project, &epic)).await?;
    data(
        s.gw.patch(
            &path,
            json!({"expected_revision":epic["revision"],"title":"Changed"}),
        )
        .await?,
        200,
    );
    assert_eq!(accept(&s, &id).await?["error"]["code"], "canon_conflict");
    assert_eq!(s.gw.get(&path).await?.status, 200);
    run(
        &s,
        &script,
        &chat,
        "오래된 삭제 제안",
        vec![("canon_propose", args(&project, &epic))],
    )
    .await?;
    assert_eq!(asks(&s, &chat).await?["open_count"], 0);
    assert!(
        stub::results(&script)
            .iter()
            .any(|r| r["error"]["code"] == "canon_conflict")
    );
    let epic = data(s.gw.get(&path).await?, 200);
    let mut mixed = args(&project, &epic);
    mixed["changes"]
        .as_array_mut()
        .unwrap()
        .insert(0, json!({"op":"epic.create","title":"Must roll back"}));
    let id = draft(&s, &script, &chat, mixed).await?;
    assert_eq!(delete(&s, &epic, &epic["revision"]).await?.status, 200);
    let refusal = accept(&s, &id).await?;
    assert_eq!(refusal["error"]["code"], "canon_not_found");
    assert!(
        !data(s.gw.get(&format!("/projects/{project}/canon")).await?, 200)
            .to_string()
            .contains("Must roll back")
    );
    assert_eq!(read(&s, &id).await?["state"], "stale");
    let epic = create(&s, &project).await?;
    let id = draft(&s, &script, &chat, args(&project, &epic)).await?;
    s.agent.kill9()?;
    s.gw = s.agent.start_again().await?;
    assert_eq!(
        s.gw.get(&format!("/canon/epics/{}", epic["id"].as_str().unwrap()))
            .await?
            .status,
        200
    );
    assert_eq!(accept(&s, &id).await?["ok"], true);
    assert_eq!(read(&s, &id).await?["state"], "applied");
    s.restart().await?;
    assert_eq!(
        s.gw.get(&format!("/canon/epics/{}", epic["id"].as_str().unwrap()))
            .await?
            .status,
        404
    );
    server.abort();
    s.finish().await
}

#[tokio::test]
async fn epic_delete_crash_replays_sidebar_unlink_receipt() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    let (mut s, _, server, project, _) = setup("EPIC-DELETE-RECEIPT", Access::AskAlways).await?;
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
    let app =
        butler_platform::sqlite::open(s.sandbox.data.join("app-server/butler-client.sqlite"))?;
    app.execute_batch("CREATE TRIGGER reject_epic_unlink BEFORE DELETE ON app_canon_conversations BEGIN SELECT RAISE(ABORT,'projection unavailable'); END;")?;
    assert_eq!(delete(&s, &epic, &epic["revision"]).await?.status, 200);
    assert_eq!(s.gw.get(&format!("/canon/epics/{id}")).await?.status, 404);
    assert_eq!(count(&app, "app_canon_conversations", id), 1);
    s.agent.kill9()?;
    app.execute_batch("DROP TRIGGER reject_epic_unlink")?;
    drop(app);
    s.gw = s.agent.start_again().await?;
    let live = LiveEvents::subscribe(&s.gw, 0).await?;
    live.wait_for(Duration::from_secs(10), |e| {
        e["type"] == "canon.changed" && e["payload"]["id"] == id && e["payload"]["deleted"] == true
    })
    .await?;
    let navigation = data(s.gw.get("/navigation").await?, 200);
    assert!(navigation.to_string().contains(&format!("s:{chat}")));
    let app =
        butler_platform::sqlite::open(s.sandbox.data.join("app-server/butler-client.sqlite"))?;
    assert_eq!(count(&app, "app_canon_conversations", id), 0);
    drop(app);
    server.abort();
    s.finish().await
}

#[tokio::test]
async fn epic_delete_requires_its_own_card_in_auto_modes() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    for access in [Access::Auto, Access::FullAccess] {
        let (s, script, server, project, chat) = setup("EPIC-DELETE-AUTO", access).await?;
        let epic = create(&s, &project).await?;
        let id = draft(&s, &script, &chat, args(&project, &epic)).await?;
        assert_eq!(
            s.gw.get(&format!("/canon/epics/{}", epic["id"].as_str().unwrap()))
                .await?
                .status,
            200
        );
        assert_eq!(accept(&s, &id).await?["ok"], true);
        server.abort();
        s.finish().await?;
    }
    Ok(())
}
