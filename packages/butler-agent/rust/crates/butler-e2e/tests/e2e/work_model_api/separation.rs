use super::*;
use butler_e2e::e2e::gateway::turn_state;

#[tokio::test]
async fn cb_13_quick_answer_in_epic_conversation_creates_no_work_or_link()
-> Result<(), HarnessError> {
    butler_e2e::gate!();
    let mut s = Setup::new("CB-13")?.cassette("TURN-01").start().await?;
    let project = project(&s).await?;
    let epic = create_epic(&s, &project, "Quick question").await?;
    let conversation = data(
        s.gw.post(
            &format!("/canon/epics/{}/conversation", epic["id"].as_str().unwrap()),
            json!({}),
        )
        .await?,
        200,
    );
    let chat = conversation["session_id"].as_str().unwrap();
    let reply = s.gw.post("/messages",json!({"chat_id":chat,"text":"Write the numbers from one to twelve as English words, separated by single spaces, and nothing else.","client_message_id":uuid::Uuid::new_v4().to_string()})).await?;
    assert_eq!(reply.status, 202, "{}", reply.text);
    let turn = s.gw.accepted_turn(reply.data()).await?;
    let answer =
        s.gw.wait_terminal(chat, &turn, Duration::from_secs(60))
            .await?;
    assert_eq!(turn_state(&answer), "delivered", "{answer}");
    let messages = s.gw.get(&format!("/messages?chat_id={chat}")).await?;
    let answers: Vec<_> = messages.data()["messages"]
        .as_array()
        .unwrap()
        .iter()
        .filter(|message| message["role"] == "assistant")
        .collect();
    assert_eq!(answers.len(), 1);
    assert_eq!(
        answers[0]["text"],
        "one two three four five six seven eight nine ten eleven twelve"
    );
    s.agent.terminate().await?;
    let db = rusqlite::Connection::open(s.sandbox.data.join("agent-runtime/btcc.sqlite"))?;
    for table in ["btcc_guided_works", "canon_epic_work_links"] {
        assert_eq!(
            db.query_row::<i64, _, _>(&format!("SELECT count(*) FROM {table}"), [], |r| r.get(0))?,
            0,
            "{table}"
        );
    }
    assert_eq!(
        db.query_row::<i64, _, _>("SELECT count(*) FROM canon_session_epics", [], |r| r.get(0))?,
        1
    );
    drop(db);
    s.finish().await
}

#[tokio::test]
async fn conversations_bind_several_epics_and_each_epic_binds_several_sessions()
-> Result<(), HarnessError> {
    butler_e2e::gate!();
    let mut s = Setup::new("CANON-MANY-SESSIONS")?.start().await?;
    let project = project(&s).await?;
    let a = create_epic(&s, &project, "First").await?;
    let b = create_epic(&s, &project, "Second").await?;
    assert!(a["home_session_id"].is_null());
    assert_eq!(a["session_ids"], json!([]));
    let path = |id: &Value| format!("/canon/epics/{}/conversation", id.as_str().unwrap());
    let first = data(s.gw.post(&path(&a["id"]), json!({})).await?, 200);
    let second = data(
        s.gw.post(&path(&b["id"]), json!({"session_id":first["session_id"]}))
            .await?,
        200,
    );
    assert_eq!(first["session_id"], second["session_id"]);
    let new_chat = data(
        s.gw.post("/sessions", json!({"kind":"project","project_id":project}))
            .await?,
        201,
    );
    let third = data(
        s.gw.post(
            &path(&a["id"]),
            json!({"session_id":new_chat["session"]["id"]}),
        )
        .await?,
        200,
    );
    assert_eq!(third["work"]["sessions"].as_array().unwrap().len(), 2);
    assert_eq!(third["work"]["home_session_id"], first["session_id"]);
    assert_eq!(
        third["work"]["session_ids"],
        json!([first["session_id"], new_chat["session"]["id"]])
    );
    assert!(
        third["work"]["sessions"]
            .as_array()
            .unwrap()
            .iter()
            .all(|s| s.get("bound_by").is_none())
    );
    let session_path = format!(
        "/session-summary?session_id={}",
        first["session_id"].as_str().unwrap()
    );
    let session = data(s.gw.get(&session_path).await?, 200);
    assert_eq!(session["epic_ids"], json!([a["id"], b["id"]]));
    let view = data(
        s.gw.get(&format!(
            "/session-view?session_id={}",
            first["session_id"].as_str().unwrap()
        ))
        .await?,
        200,
    );
    assert_eq!(view["epic_ids"], session["epic_ids"]);
    let listed = data(
        s.gw.get(&format!("/sessions?project_id={project}")).await?,
        200,
    );
    let entry = listed["sessions"]
        .as_array()
        .unwrap()
        .iter()
        .find(|s| s["id"] == first["session_id"])
        .unwrap();
    assert_eq!(entry["epic_ids"], session["epic_ids"]);
    let chats = data(s.gw.get("/chats").await?, 200);
    let entry = chats
        .as_array()
        .unwrap()
        .iter()
        .find(|c| c["id"] == first["session_id"])
        .unwrap();
    assert_eq!(entry["epic_ids"], session["epic_ids"]);
    let space = data(s.gw.get("/navigation").await?, 200);
    let nodes = space["space"]["nodes"].as_array().unwrap();
    assert!(
        nodes
            .iter()
            .any(|n| n["entityId"] == new_chat["session"]["id"])
    );
    assert!(!nodes.iter().any(|n| n["entityId"] == first["session_id"]));
    let sidebar = data(
        s.gw.get(&format!("/projects/{project}/canon/sidebar"))
            .await?,
        200,
    );
    let rows = sidebar["groups"][0]["rows"].as_array().unwrap();
    assert_eq!(rows.len(), 2);
    assert!(rows.iter().all(|row| {
        row["sessions"]
            .as_array()
            .unwrap()
            .iter()
            .any(|binding| binding["session_id"] == first["session_id"])
    }));
    s.restart().await?;
    let reloaded = data(
        s.gw.get(&format!("/canon/epics/{}", a["id"].as_str().unwrap()))
            .await?,
        200,
    );
    assert_eq!(reloaded["sessions"], third["work"]["sessions"]);
    let done = data(
        s.gw.patch(
            &format!("/canon/epics/{}", a["id"].as_str().unwrap()),
            json!({"expected_revision":reloaded["revision"],"status":"done"}),
        )
        .await?,
        200,
    );
    assert_eq!(done["canon_status"], "done");
    let obsolete = s.gw.patch(&format!("/canon/epics/{}",a["id"].as_str().unwrap()),json!({"expected_revision":done["revision"],"expected_task_graph_revision":0,"status":"planned"})).await?;
    assert_eq!(obsolete.status, 400);
    s.finish().await
}

#[tokio::test]
async fn canon_conversation_rejects_missing_unscoped_and_other_project_sessions()
-> Result<(), HarnessError> {
    butler_e2e::gate!();
    let s = Setup::new("CANON-BIND-SCOPE")?.start().await?;
    let project_id = project(&s).await?;
    let epic = create_epic(&s, &project_id, "Scope").await?;
    let other = data(
        s.gw.post(
            "/projects",
            json!({"source":"scratch","display_name":"Other"}),
        )
        .await?,
        201,
    );
    let chat = data(s.gw.post("/sessions", json!({"kind":"chat"})).await?, 201);
    let foreign = data(
        s.gw.post(
            "/sessions",
            json!({"kind":"project","project_id":other["project"]["id"]}),
        )
        .await?,
        201,
    );
    for session in [
        json!("missing"),
        // A nonexistent subsession is covered by the missing-session case.
        chat["session"]["id"].clone(),
        foreign["session"]["id"].clone(),
    ] {
        let reply =
            s.gw.post(
                &format!("/canon/epics/{}/conversation", epic["id"].as_str().unwrap()),
                json!({"session_id":session}),
            )
            .await?;
        assert_eq!(reply.status, 400, "{}", reply.text);
        assert_eq!(
            serde_json::from_str::<Value>(&reply.text)?["error"]["code"],
            "work_model_invalid"
        );
    }
    s.finish().await
}
