use super::*;
use butler_canon::store;
async fn proposal(s: &Scenario, revision: &Value, body: &str) -> Result<Value, HarnessError> {
    call(s,"canon_propose_spec_change",json!({"spec_id":"shared-spec","base_revision":revision,"body":body,"summary":"Review changes"})).await
}
#[tokio::test]
async fn cn_11_mcp_proposals_preserve_chat_drafts_and_private_specs() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    let mut s = Setup::new("CN-11-DRAFTS")?
        .data_folder_token()
        .start()
        .await?;
    let project = project(&s).await?;
    trust(&s).await?;
    let epic = call(
        &s,
        "canon_create_epic",
        json!({"project":project,"title":"Draft separation"}),
    )
    .await?;
    let id = epic["id"].as_str().unwrap();
    writes::seed_spec(&mut s, id, &project).await?;
    s.agent.terminate().await?;
    let mut db = rusqlite::Connection::open(s.sandbox.data.join("agent-runtime/btcc.sqlite"))?;
    db.execute("INSERT INTO canon_spec_nodes(node_id,scope_kind,scope_ref,epic_id,concern_id,visibility,lifecycle,source,created_at,updated_at,created_by) VALUES('private-spec','session','private-session',?1,'Private design','private','draft','local',1,1,'{}')",[id])?;
    let tx = store::Transaction::new(db.transaction()?).map_err(store_error)?;
    store::create_canon_proposal(&tx,&store::Context{now:1,actor:json!({"person":"app-user","via":"butler","origin":"chat"})},
        &json!({"id":"conversation-proposal","session_id":"owner","source_turn_id":"turn","source_call_id":"call","project_id":project,"summary":"Conversation draft","created_at":"2026-01-01T00:00:00Z",
            "document":{"changes":[{"op":"spec.edit","id":"shared-spec","expected_revision":0,"body":"Conversation design"}]}})).map_err(store_error)?;
    tx.commit()?;
    drop(db);
    s.restart().await?;
    let a = proposal(&s, &json!(0), "First design").await?;
    let b = proposal(&s, &json!(0), "Second design").await?;
    let detail = s.gw.get(&format!("/canon/epics/{id}")).await?;
    assert_eq!(detail.data()["proposals"].as_array().unwrap().len(), 2);
    let client = call(&s, "canon_get_epic", json!({"epic_id":id})).await?;
    assert!(!client.to_string().contains("private-spec"));
    let private = s.gw.get("/canon/specs/private-spec").await?;
    assert_eq!(private.status, 404);
    let accepted =
        s.gw.post(
            &format!("/canon/proposals/{}", a["id"].as_str().unwrap()),
            json!({"outcome":"accepted"}),
        )
        .await?;
    assert_eq!(accepted.status, 200, "{}", accepted.text);
    let stale =
        s.gw.post(
            &format!("/canon/proposals/{}", b["id"].as_str().unwrap()),
            json!({"outcome":"accepted"}),
        )
        .await?;
    assert_eq!(stale.data()["error"]["code"], "canon_conflict");
    let conflict = proposal(&s, &json!(0), "Old revision").await?;
    assert_eq!(conflict["error"]["code"], "conflict");
    assert_eq!(conflict["error"]["current"]["revision"], 2);
    s.agent.terminate().await?;
    let db = rusqlite::Connection::open(s.sandbox.data.join("agent-runtime/btcc.sqlite"))?;
    let state: String = db.query_row(
        "SELECT state FROM canon_proposals WHERE id='conversation-proposal'",
        [],
        |r| r.get(0),
    )?;
    assert_eq!(state, "open");
    let (state, by): (String, String) = db.query_row(
        "SELECT state,resolved_by FROM canon_proposals WHERE id=?1",
        [b["id"].as_str().unwrap()],
        |r| Ok((r.get(0)?, r.get(1)?)),
    )?;
    assert_eq!((state.as_str(), by.as_str()), ("stale", "inspector"));
    drop(db);
    s.finish().await
}
