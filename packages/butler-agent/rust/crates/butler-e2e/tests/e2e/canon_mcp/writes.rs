use super::*;
use butler_canon::store;

pub(super) async fn seed_spec(
    s: &mut Scenario,
    epic: &str,
    project: &str,
) -> Result<(), HarnessError> {
    s.agent.terminate().await?;
    let mut db = rusqlite::Connection::open(s.sandbox.data.join("agent-runtime/btcc.sqlite"))?;
    let tx = store::Transaction::new(db.transaction()?).map_err(|error| store_error(&error))?;
    let ctx = store::Context {
        now: 1,
        actor: json!({"person":"app-user","via":"app"}),
    };
    let node = store::NewSpecNode {
        id: "shared-spec".into(),
        scope_kind: butler_canon::work_types::ScopeKind::Project,
        scope_ref: project.into(),
        epic_id: Some(epic.into()),
        parent_node_id: None,
        concern_id: "Shared design".into(),
    };
    store::create_spec_node(
        &tx,
        &ctx,
        &node,
        &store::Registration::Canon(store::UserAct::new("app-user")),
    )
    .map_err(|error| store_error(&error))?;
    tx.commit()?;
    drop(db);
    s.restart().await
}
#[tokio::test]
async fn cn_11_mcp_updates_comments_creates_and_proposes() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    let mut s = Setup::new("CN-11")?.data_folder_token().start().await?;
    let project = project(&s).await?;
    trust(&s).await?;
    let created=call(&s,"canon_create_epic",json!({"project":"Canon MCP","title":"External design","description":"Shared","assign_to_me":true})).await?;
    assert!(created["error"].is_null(), "{created}");
    let id = created["id"].as_str().unwrap().to_owned();
    assert!(created["plan"].is_null());
    assert_eq!(created["assignee"], "app-user");
    let app = s.gw.get(&format!("/canon/epics/{id}")).await?;
    assert_eq!(app.data()["origin"], "mcp");
    let updated = call(
        &s,
        "canon_update_epic_status",
        json!({"epic_id":id,"expected_revision":created["revision"],"status":"in_progress"}),
    )
    .await?;
    assert_eq!(updated["status"], "in_progress");
    let app = s.gw.get(&format!("/canon/epics/{id}")).await?;
    assert_eq!(app.data()["activity"][0]["from"], "planned");
    assert_eq!(app.data()["activity"][0]["to"], "in_progress");
    assert!(updated["activity"][0].get("from").is_none());
    assert!(updated["activity"][0].get("to").is_none());
    assert!(updated["activity"][0]["body"].is_null());
    let conflict = call(
        &s,
        "canon_update_epic_status",
        json!({"epic_id":id,"expected_revision":created["revision"],"status":"done"}),
    )
    .await?;
    assert_eq!(conflict["error"]["code"], "conflict");
    assert_eq!(
        conflict["error"]["current"]["revision"],
        updated["revision"]
    );
    let comment = call(
        &s,
        "canon_comment_epic",
        json!({"epic_id":id,"body":"Decision\nFull explanation"}),
    )
    .await?;
    assert_eq!(comment["activity"][0]["summary"], "Decision");
    assert_eq!(comment["activity"][0]["body"], "Decision\nFull explanation");
    seed_spec(&mut s, &id, &project).await?;
    let spec = call(&s, "canon_get_spec", json!({"epic_id":id})).await?;
    let proposal=call(&s,"canon_propose_spec_change",json!({"spec_id":spec["id"],"base_revision":spec["revision"],"body":"# Changed design","summary":"Review design"})).await?;
    let detail = s.gw.get(&format!("/canon/epics/{id}")).await?;
    assert_eq!(detail.data()["proposals"][0]["id"], proposal["id"]);
    let accepted =
        s.gw.post(
            &format!("/canon/proposals/{}", proposal["id"].as_str().unwrap()),
            json!({"outcome":"accepted"}),
        )
        .await?;
    assert_eq!(accepted.status, 200, "{}", accepted.text);
    assert_eq!(accepted.data()["ok"], true);
    let spec = call(&s, "canon_get_spec", json!({"spec_id":spec["id"]})).await?;
    assert_eq!(spec["body"], "# Changed design");
    assert!(spec["revision"].as_i64().unwrap() > 0);
    let proposal=call(&s,"canon_propose_spec_change",json!({"spec_id":spec["id"],"base_revision":spec["revision"],"body":"Declined","summary":"Alternative"})).await?;
    let reply =
        s.gw.post(
            &format!("/canon/proposals/{}", proposal["id"].as_str().unwrap()),
            json!({"outcome":"declined"}),
        )
        .await?;
    assert_eq!(reply.status, 200, "{}", reply.text);
    let epic = call(&s, "canon_get_epic", json!({"epic_id":id})).await?;
    for kind in [
        "created",
        "status",
        "comment",
        "proposal_opened",
        "proposal_applied",
        "proposal_declined",
    ] {
        assert!(
            epic["activity"]
                .as_array()
                .unwrap()
                .iter()
                .any(|a| a["kind"] == kind),
            "{kind}: {epic}"
        );
    }
    assert_eq!(
        call(
            &s,
            "canon_get_epic",
            json!({"project":project,"issue_number":12})
        )
        .await?["error"]["code"],
        "not_linked"
    );
    s.finish().await
}

#[tokio::test]
async fn cn_12_mcp_creates_and_edits_plans_epics_and_tags() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    let s = Setup::new("CN-12")?.data_folder_token().start().await?;
    let project = project(&s).await?;
    trust(&s).await?;
    let plan = call(
        &s,
        "canon_create_plan",
        json!({"project":"Canon MCP","title":"External plan"}),
    )
    .await?;
    let first = call(
        &s,
        "canon_create_epic",
        json!({"project":project,"title":"First epic","plan_id":plan["id"]}),
    )
    .await?;
    assert_eq!(first["plan"]["id"], plan["id"]);
    let tag = call(
        &s,
        "canon_create_tag",
        json!({"project":project,"name":"Bug","color":"red"}),
    )
    .await?;
    assert_eq!(tag["name"], "Bug");
    let second = call(
        &s,
        "canon_create_epic",
        json!({"project":project,"title":"Backlog epic","tag_ids":[tag["id"]]}),
    )
    .await?;
    assert!(second["plan"].is_null());
    assert_eq!(second["tags"][0]["id"], tag["id"]);
    let id = second["id"].as_str().unwrap();
    let edited = call(&s, "canon_edit_epic", json!({"epic_id":id,"expected_revision":second["revision"],"title":"Edited epic","description":"Updated description","plan_id":plan["id"],"before_id":first["id"]})).await?;
    assert_eq!(edited["title"], "Edited epic");
    assert_eq!(edited["description"], "Updated description");
    let page = call(
        &s,
        "canon_list",
        json!({"project":project,"plan_id":plan["id"]}),
    )
    .await?;
    let mut order: Vec<_> = page["epics"].as_array().unwrap().iter().collect();
    order.sort_by_key(|epic| epic["order"].as_str().unwrap().to_owned());
    let order: Vec<_> = order.iter().map(|epic| &epic["id"]).collect();
    assert_eq!(order, [&json!(id), &first["id"]]);
    let updated = call(
        &s,
        "canon_update_epic_status",
        json!({"epic_id":id,"expected_revision":edited["revision"],"status":"in_progress"}),
    )
    .await?;
    assert_eq!(updated["status"], "in_progress");
    let returned = call(
        &s,
        "canon_edit_epic",
        json!({"epic_id":id,"expected_revision":updated["revision"],"plan_id":null}),
    )
    .await?;
    assert!(returned["error"].is_null(), "{returned}");
    assert!(returned["plan"].is_null());
    let app = s.gw.get(&format!("/canon/epics/{id}")).await?;
    let activity = app.data()["activity"].as_array().unwrap();
    assert_eq!(activity.len(), 5);
    for kind in ["created", "edited", "status"] {
        assert_eq!(activity.iter().filter(|row| row["kind"] == kind).count(), 1);
    }
    let moves: Vec<_> = activity
        .iter()
        .filter(|row| row["kind"] == "moved")
        .collect();
    assert_eq!(moves.len(), 2);
    assert!(moves.iter().any(|row| row["summary"] == "External plan"));
    assert!(moves.iter().any(|row| row["summary"] == ""));
    for row in activity {
        assert_eq!(row["actor"]["via"], "Claude Code");
        assert_eq!(row["actor"]["origin"], "mcp");
    }
    let listed = call(&s, "canon_list", json!({"project":project})).await?;
    let current = listed["plans"]
        .as_array()
        .unwrap()
        .iter()
        .find(|row| row["id"] == plan["id"])
        .unwrap()["revision"]
        .as_i64()
        .unwrap();
    let renamed = call(&s, "canon_edit_plan", json!({"plan_id":plan["id"],"expected_revision":current,"title":"Renamed plan","description":"Plan notes","due_on":"2026-12-01"})).await?;
    assert_eq!(renamed["title"], "Renamed plan");
    assert_eq!(renamed["description"], "Plan notes");
    assert_eq!(renamed["revision"], current + 1);
    let db = rusqlite::Connection::open(s.sandbox.data.join("agent-runtime/btcc.sqlite"))?;
    let (actor, due): (String, Option<String>) = db.query_row(
        "SELECT a.actor_json, p.due_on FROM canon_audit a JOIN canon_plans p ON p.id=a.entity_id WHERE a.entity_kind='plan' AND a.op='edit' AND a.entity_id=?1",
        [plan["id"].as_str().unwrap()],
        |row| Ok((row.get(0)?, row.get(1)?)),
    )?;
    let actor: Value = serde_json::from_str(&actor)?;
    assert_eq!(actor["via"], "Claude Code");
    assert_eq!(actor["origin"], "mcp");
    assert_eq!(due.as_deref(), Some("2026-12-01"));
    let current =
        call(&s, "canon_get_epic", json!({"epic_id":first["id"]})).await?["revision"].clone();
    let tagged = call(
        &s,
        "canon_edit_epic",
        json!({"epic_id":first["id"],"expected_revision":current,"tag_ids":[tag["id"]]}),
    )
    .await?;
    assert_eq!(tagged["tags"][0]["id"], tag["id"], "{tagged}");
    let app =
        s.gw.get(&format!("/canon/epics/{}", first["id"].as_str().unwrap()))
            .await?;
    let edited: Vec<_> = app.data()["activity"]
        .as_array()
        .unwrap()
        .iter()
        .filter(|row| row["kind"] == "edited")
        .collect();
    assert_eq!(edited.len(), 1);
    assert_eq!(edited[0]["actor"]["via"], "Claude Code");
    let tags = call(&s, "canon_list_tags", json!({"project":project})).await?;
    assert_eq!(tags["tags"].as_array().unwrap().len(), 1);
    s.finish().await
}
