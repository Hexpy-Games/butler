//! Epic deletion uses the same transaction for HTTP and approved chat drafts.
use super::*;
mod admission_failure;
mod archived_queue;
mod delegation_guard;
mod delivery_failure;
mod guards;
mod held_steps;
mod lifecycle;
mod panels;
mod queue;
mod receipts;
mod requires_e2e_fixtures;
mod terminal_events;

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
    let (mut s, script, server, project, _) = setup("EPIC-DELETE-HTTP", Access::AskAlways).await?;
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
    run(&s, &script, &chat, "Prepare independent work", vec![
        ("replace_work_plan", json!({"objective":"Preserve independent work","execution_mode":"direct","actions":[{"action_key":"inspect","description":"Inspect content"}],"checks":["Content preserved"]})),
        ("record_work_review", json!({"subject":"plan","verdict":"accept","summary":"Scope confirmed"})),
        ("record_work_checkpoint", json!({"action_updates":[{"action_key":"inspect","status":"done"}],"public_summary":"Content checked","next_step":"Review"})),
        ("record_work_review", json!({"subject":"result","verdict":"accept","summary":"Content preserved"})),
        ("record_work_review", json!({"subject":"completion","verdict":"accept","summary":"Verified"})),
        ("record_work_disposition", json!({"work_id":"$work","disposition":"completed","summary":"Verified content","action_updates":[],"remaining_actions":[],"followups":[]})),
    ]).await?;
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
    canon.execute("INSERT INTO canon_intents(op_id,kind,payload_json,state,created_at) VALUES('delete-intent','canon_hold',?1,'applied',0)", [json!({"session_id":owner,"epic_id":id,"epic_title":"삭제할 과제","state":"pending"}).to_string()])?;
    let app =
        butler_platform::sqlite::open(s.sandbox.data.join("app-server/butler-client.sqlite"))?;
    app.execute("INSERT INTO app_initiated_messages(id,chat_id,kind,source_key,text,payload_json,state,created_at) VALUES('delete-panel',?1,'canon_hold','delete-intent','Pending',?2,'posted','2026-01-01')", rusqlite::params![chat,json!({"panel":{"epic_id":id,"state":"pending"}}).to_string()])?;
    drop(app);
    canon.execute("INSERT INTO canon_epic_work_links(epic_id,btcc_work_id,session_id,linked_at,linked_by) SELECT ?1,work_id,session_id,0,'{}' FROM btcc_guided_works WHERE session_id=?2 LIMIT 1", rusqlite::params![id,owner])?;
    canon.execute("INSERT INTO canon_tags(id,project_id,name,name_key,color,created_at,updated_at,created_by) VALUES('preserved-tag',?1,'유지','유지','gray',0,0,'{}')", [&project])?;
    canon.execute(
        "INSERT INTO canon_epic_tags VALUES(?1,'preserved-tag')",
        [id],
    )?;
    assert_eq!(count(&canon, "canon_epic_work_links", id), 1);
    assert_eq!(count(&canon, "canon_epic_tags", id), 1);
    canon.execute("INSERT INTO canon_spec_nodes(node_id,scope_kind,scope_ref,epic_id,concern_id,visibility,lifecycle,source,created_at,updated_at,created_by) VALUES('delete-spec','project',?1,?2,'User design','canon','draft','local',0,0,'{}')", rusqlite::params![project,id])?;
    let spec_draft = data(
        s.gw.post(
            "/canon/specs/delete-spec/proposals",
            json!({"base_revision":0,"body":"Draft content","summary":"Spec draft"}),
        )
        .await?,
        200,
    );
    canon.execute("INSERT INTO canon_intents(op_id,kind,payload_json,state,created_at) VALUES('delete-pending-step','canon_step',?1,'pending',0)", [json!({"session_id":owner,"epic_id":id}).to_string()])?;
    assert_eq!(
        canon.query_row::<i64, _, _>(
            "SELECT count(*) FROM canon_intents WHERE op_id='delete-pending-step'",
            [],
            |r| r.get(0)
        )?,
        1
    );
    let before: i64 =
        canon.query_row("SELECT count(*) FROM btcc_guided_works", [], |r| r.get(0))?;
    let stale = delete(&s, &epic, &json!(-1)).await?;
    assert_eq!(stale.status, 409);
    assert_eq!(count(&canon, "canon_session_epics", id), 1);
    canon.execute_batch("CREATE TRIGGER refuse_epic_delete BEFORE DELETE ON canon_epics BEGIN SELECT RAISE(ABORT,'unavailable'); END;")?;
    assert_eq!(delete(&s, &epic, &epic["revision"]).await?.status, 500);
    for table in ["canon_session_queue", "canon_session_epics"] {
        assert_eq!(count(&canon, table, id), 1, "rollback {table}");
    }
    canon.execute_batch("DROP TRIGGER refuse_epic_delete")?;
    assert_eq!(delete(&s, &epic, &epic["revision"]).await?.status, 200);
    for table in [
        "canon_session_queue",
        "canon_session_epics",
        "canon_epic_work_links",
        "canon_epic_tags",
    ] {
        assert_eq!(count(&canon, table, id), 0, "{table}");
    }
    assert_eq!(
        canon.query_row::<i64, _, _>(
            "SELECT count(*) FROM canon_intents WHERE json_extract(payload_json,'$.epic_id')=?1 AND kind NOT IN ('canon_hold','canon_take_here')",
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
    assert_eq!(
        canon.query_row::<String, _, _>(
            "SELECT state FROM canon_proposals WHERE id=?1",
            [spec_draft["id"].as_str().unwrap()],
            |r| r.get(0)
        )?,
        "stale"
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
    panels::wait_settled(&app, "delete-intent").await?;
    assert_eq!(
        db(&s)?.query_row::<i64, _, _>(
            "SELECT count(*) FROM canon_tags WHERE id='preserved-tag'",
            [],
            |r| r.get(0)
        )?,
        1
    );
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
    let card = read(&s, &id).await?;
    assert_eq!(card["epics"].as_array().unwrap().len(), 1);
    assert_eq!(card["changes"][1]["title"], "Changed");
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

async fn wait_receipt(s: &Scenario, epic: &str) -> Result<(), HarnessError> {
    let canon = db(s)?;
    let deadline = std::time::Instant::now() + Duration::from_secs(15);
    while canon.query_row::<i64,_,_>("SELECT count(*) FROM canon_session_queue WHERE epic_id=?1 AND step_op_id IS NOT NULL AND turn_ended_at IS NULL",[epic],|r|r.get(0))? > 0 {
        assert!(std::time::Instant::now() < deadline,"terminal receipt missing");
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
    Ok(())
}
