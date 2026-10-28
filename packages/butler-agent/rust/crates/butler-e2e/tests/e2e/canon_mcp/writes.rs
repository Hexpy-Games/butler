use super::*;
use butler_canon::store;

pub(super) async fn seed_spec(
    s: &mut Scenario,
    epic: &str,
    project: &str,
) -> Result<(), HarnessError> {
    s.agent.terminate().await?;
    let mut db = rusqlite::Connection::open(s.sandbox.data.join("agent-runtime/btcc.sqlite"))?;
    let tx = store::Transaction::new(db.transaction()?).map_err(store_error)?;
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
    .map_err(store_error)?;
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
