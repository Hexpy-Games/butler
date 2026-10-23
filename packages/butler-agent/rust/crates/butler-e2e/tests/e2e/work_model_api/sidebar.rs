use super::*;

async fn link(s: &Scenario, id: &Value) -> Result<Value, HarnessError> {
    Ok(data(
        s.gw.post(
            &format!("/canon/epics/{}/conversation", id.as_str().unwrap()),
            json!({}),
        )
        .await?,
        200,
    ))
}
async fn sidebar(s: &Scenario, project: &str) -> Result<Value, HarnessError> {
    Ok(data(
        s.gw.get(&format!("/projects/{project}/canon/sidebar"))
            .await?,
        200,
    ))
}
#[tokio::test]
async fn wma_sidebar_conversation_navigation_and_replay() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    let mut s = Setup::new("WMA-SIDEBAR-LINK")?.start().await?;
    let project = project(&s).await?;
    let work = create_epic(&s, &project, "Conversation navigation").await?;
    let stream = LiveEvents::subscribe(&s.gw, 0).await?;
    let (a, b) = tokio::join!(link(&s, &work["id"]), link(&s, &work["id"]));
    let a = a?;
    assert_eq!(a["session_id"], b?["session_id"]);
    assert_eq!(a["work"]["home_session_id"], a["session_id"]);
    let chat = a["session_id"].as_str().unwrap();
    let session = data(
        s.gw.get(&format!("/project-sessions?project_id={project}"))
            .await?,
        200,
    );
    assert!(session.to_string().contains(&project));
    assert!(session.to_string().contains("Conversation navigation"));
    event(&stream, "canon.changed", work["id"].as_str().unwrap()).await?;
    let nav = data(s.gw.get("/navigation").await?, 200);
    assert!(
        !nav["space"]["nodes"]
            .as_array()
            .unwrap()
            .iter()
            .any(|n| n["entity_id"] == chat || n["entityId"] == chat)
    );
    // Recent/running use these full session summaries; only tree membership changes.
    assert!(nav["projects"].to_string().contains(chat));
    let sessions = data(
        s.gw.get(&format!("/sessions?project_id={project}")).await?,
        200,
    );
    assert!(sessions.to_string().contains(chat));
    let search = data(s.gw.get("/command-palette?query=Conversation").await?, 200);
    assert!(search.to_string().contains(chat));
    let missing =
        s.gw.post("/canon/epics/missing/conversation", json!({}))
            .await?;
    assert_eq!(missing.status, 404);
    let other = create_epic(&s, &project, "Another work").await?;
    s.agent.terminate().await?;
    let output = tokio::process::Command::new(butler_e2e::e2e::binary::fixture_binary(
        "e2e-canon-conversation",
    )?)
    .kill_on_drop(true)
    .arg(s.sandbox.data.join("agent-runtime/btcc.sqlite"))
    .args([work["id"].as_str().unwrap(), other["id"].as_str().unwrap()])
    .output()
    .await?;
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    // Simulate a crash between the BTCC commit and App projection commit.
    let app_db =
        rusqlite::Connection::open(s.sandbox.data.join("app-server/butler-client.sqlite"))?;
    let plan: String = app_db.query_row(
        "EXPLAIN QUERY PLAN SELECT 1 FROM app_canon_conversations cc WHERE cc.session_id=?1",
        [chat],
        |row| row.get(3),
    )?;
    assert!(plan.contains("SEARCH cc"), "{plan}");
    app_db.execute("DELETE FROM app_canon_conversations", [])?;
    drop(app_db);
    let btcc = rusqlite::Connection::open(s.sandbox.data.join("agent-runtime/btcc.sqlite"))?;
    btcc.execute(
        "UPDATE wm_cross_db_intents SET state='pending' WHERE kind='canon_conversation'",
        [],
    )?;
    drop(btcc);
    s.restart().await?;
    let recovered = LiveEvents::subscribe(&s.gw, 0).await?;
    recovered
        .wait_for(Duration::from_secs(10), |e| {
            e["type"] == "space.changed"
                && e["payload"]["revision"]
                    .as_i64()
                    .is_some_and(|v| v > nav["space"]["revision"].as_i64().unwrap())
        })
        .await?;
    assert_eq!(link(&s, &work["id"]).await?["session_id"], a["session_id"]);
    s.finish().await
}
#[tokio::test]
async fn wma_sidebar_personal_order_preserves_canon() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    let mut s = Setup::new("WMA-SIDEBAR-ORDER")?.start().await?;
    let project = project(&s).await?;
    let plan = create_plan(&s, &project, "A plan").await?;
    let a = create_epic(&s, &project, "A").await?;
    let b = create_epic(&s, &project, "B").await?;
    let hidden = create_epic(&s, &project, "Hidden").await?;
    link(&s, &a["id"]).await?;
    data(
        s.gw.patch(
            &format!("/canon/epics/{}", b["id"].as_str().unwrap()),
            json!({"expected_revision":b["revision"],"assignee":"app-user"}),
        )
        .await?,
        200,
    );
    let initial = overview(&s, &project).await?;
    let view = sidebar(&s, &project).await?;
    assert_eq!(view["groups"][0]["kind"], "backlog");
    assert_eq!(view["groups"][1]["key"], plan["id"]);
    assert_eq!(
        ids(&view["groups"][0]["rows"]),
        vec![a["id"].as_str().unwrap(), b["id"].as_str().unwrap()]
    );
    let path = format!("/projects/{project}/canon/sidebar-order");
    let input =
        json!({"group_key":"backlog","work_ids":[b["id"],a["id"]],"op_id":"personal-order"});
    for _ in 0..2 {
        data(s.gw.post(&path, input.clone()).await?, 200);
    }
    assert_eq!(overview(&s, &project).await?, initial);
    assert_eq!(
        sidebar(&s, &project).await?["groups"][0]["rows"][0]["id"],
        b["id"]
    );
    s.restart().await?;
    assert_eq!(
        sidebar(&s, &project).await?["groups"][0]["rows"][0]["id"],
        b["id"]
    );
    let c = create_epic(&s, &project, "C").await?;
    link(&s, &c["id"]).await?;
    assert_eq!(
        ids(&sidebar(&s, &project).await?["groups"][0]["rows"]),
        vec![
            b["id"].as_str().unwrap(),
            a["id"].as_str().unwrap(),
            c["id"].as_str().unwrap()
        ]
    );
    assert_eq!(
        s.gw.post(
            &path,
            json!({"group_key":"backlog","work_ids":[hidden["id"]]})
        )
        .await?
        .status,
        400
    );
    s.finish().await
}
