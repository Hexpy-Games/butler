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
    let tx = store::Transaction::new(db.transaction()?).map_err(|error| store_error(&error))?;
    store::create_canon_proposal(&tx,&store::Context{now:1,actor:json!({"person":"app-user","via":"butler","origin":"chat"})},
        &json!({"id":"conversation-proposal","session_id":"owner","source_turn_id":"turn","source_call_id":"call","project_id":project,"summary":"Conversation draft","created_at":"2026-01-01T00:00:00Z",
            "document":{"changes":[{"op":"spec.edit","id":"shared-spec","expected_revision":0,"body":"Conversation design"}]}})).map_err(|error|store_error(&error))?;
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

#[tokio::test]
async fn cn_16_mcp_proposes_specs_the_owner_applies_and_finds_them() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    let s = Setup::new("CN-16")?.data_folder_token().start().await?;
    let project = project(&s).await?;
    trust(&s).await?;
    let epic = call(
        &s,
        "canon_create_epic",
        json!({"project":project,"title":"Export"}),
    )
    .await?;
    let id = epic["id"].as_str().unwrap();
    let invalid = call(
        &s,
        "canon_propose_spec",
        json!({"epic_id":id,"body":"No title","summary":"Export design"}),
    )
    .await?;
    assert!(
        invalid["error"]["message"]
            .as_str()
            .is_some_and(|m| m.contains("must start with")),
        "{invalid}"
    );
    let detail = s.gw.get(&format!("/canon/epics/{id}")).await?;
    assert_eq!(detail.data()["proposals"], json!([]));
    let body = "# Export design\n\nFirst draft";
    let first = call(
        &s,
        "canon_propose_spec",
        json!({"epic_id":id,"body":body,"summary":"Export design"}),
    )
    .await?;
    let other_body = "# Other design\n\nSecond";
    let second = call(
        &s,
        "canon_propose_spec",
        json!({"epic_id":id,"body":other_body,"summary":"Other design"}),
    )
    .await?;
    assert_eq!(first["state"], "open", "{first}");
    let detail = s.gw.get(&format!("/canon/epics/{id}")).await?;
    let proposals = detail.data()["proposals"].as_array().unwrap();
    assert_eq!(proposals.len(), 2, "{second}");
    assert!(proposals.iter().all(|p| p["current_body"].is_null()));
    assert_eq!(detail.data()["specs"], json!([]));
    assert_eq!(
        call(&s, "canon_get_epic", json!({"epic_id":id})).await?["specs"],
        json!([])
    );
    for proposal in [&first, &second] {
        let accepted =
            s.gw.post(
                &format!("/canon/proposals/{}", proposal["id"].as_str().unwrap()),
                json!({"outcome":"accepted"}),
            )
            .await?;
        assert_eq!(accepted.data()["ok"], true, "{}", accepted.text);
    }
    let epic = call(&s, "canon_get_epic", json!({"epic_id":id})).await?;
    let specs = epic["specs"].as_array().unwrap();
    assert_eq!(specs.len(), 2);
    let page = call(&s, "canon_list", json!({"project":project})).await?;
    let listed = page["epics"]
        .as_array()
        .unwrap()
        .iter()
        .find(|e| e["id"] == id)
        .unwrap();
    assert_eq!(listed["specs"].as_array().unwrap().len(), 2);
    let bodies = call(&s, "canon_get_spec", json!({"epic_id":id})).await?;
    assert_eq!(bodies["specs"].as_array().unwrap().len(), 2);
    for (title, body) in [("Export design", body), ("Other design", other_body)] {
        let spec = specs.iter().find(|s| s["title"] == title).unwrap();
        assert!(
            listed["specs"]
                .as_array()
                .unwrap()
                .contains(&json!({"id":spec["id"],"title":title}))
        );
        let found = bodies["specs"]
            .as_array()
            .unwrap()
            .iter()
            .find(|s| s["id"] == spec["id"])
            .unwrap();
        assert_eq!(found["body"], body);
    }
    let spec = bodies["specs"]
        .as_array()
        .unwrap()
        .iter()
        .find(|s| s["title"] == "Export design")
        .unwrap();
    let single = call(&s, "canon_get_spec", json!({"spec_id":spec["id"]})).await?;
    assert_eq!(single["specs"], json!([spec]));
    let revised = "# Export design\n\nRevised draft";
    let edit = call(&s, "canon_propose_spec_change", json!({"spec_id":spec["id"],"base_revision":spec["revision"],"body":revised,"summary":"Revise export"})).await?;
    assert_eq!(edit["state"], "open", "{edit}");
    let accepted =
        s.gw.post(
            &format!("/canon/proposals/{}", edit["id"].as_str().unwrap()),
            json!({"outcome":"accepted"}),
        )
        .await?;
    assert_eq!(accepted.data()["ok"], true, "{}", accepted.text);
    assert_eq!(
        call(&s, "canon_get_spec", json!({"spec_id":spec["id"]})).await?["specs"][0]["body"],
        revised
    );
    s.finish().await
}
