use super::*;
#[tokio::test]
async fn child_criteria_count_and_same_ids_are_scoped_to_their_node() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    let (mut s, project, epic) = fixture("CC-tree").await?;
    s.agent.terminate().await?;
    let mut db = rusqlite::Connection::open(s.sandbox.data.join("agent-runtime/btcc.sqlite"))?;
    let tx = store::Transaction::new(db.transaction()?).map_err(|e| err(&e))?;
    let ctx = store::Context {
        now: 2,
        actor: json!({"person":"app-user","via":"app"}),
    };
    for (node, parent) in [
        ("child-spec", Some("criteria-spec")),
        ("grandchild-spec", Some("child-spec")),
        ("other-root", None),
    ] {
        store::create_spec_node(
            &tx,
            &ctx,
            &store::NewSpecNode {
                id: node.into(),
                scope_kind: butler_canon::work_types::ScopeKind::Project,
                scope_ref: project.clone(),
                epic_id: Some(epic.clone()),
                parent_node_id: parent.map(str::to_owned),
                concern_id: node.into(),
            },
            &store::Registration::Canon(store::UserAct::new("app-user")),
        )
        .map_err(|e| err(&e))?;
        publish_node(
            &tx,
            &ctx,
            node,
            1,
            &[("VB-03", "표시", "변경 내용을 확인할 수 있다")],
        )?;
    }
    tx.commit()?;
    drop(db);
    s.restart().await?;
    count(&s, &epic, 0, 5).await?;
    let reply =
        s.gw.post(
            "/canon/specs/child-spec/criteria/VB-03",
            json!({"confirmed":true,"expected_revision":2}),
        )
        .await?;
    assert_eq!(reply.status, 200, "{}", reply.text);
    let detail = count(&s, &epic, 1, 5).await?;
    let root = detail["specs"]
        .as_array()
        .unwrap()
        .iter()
        .find(|n| n["node_id"] == "criteria-spec")
        .unwrap();
    assert_eq!(root["criteria"][0]["confirmed"], false);
    assert_eq!(root["children"][0]["criteria"][0]["confirmed"], true);
    assert_eq!(
        root["children"][0]["children"][0]["criteria"][0]["confirmed"],
        false
    );
    let list = s.gw.get(&format!("/canon/list?project={project}")).await?;
    assert_eq!(list.data()["epics"][0]["criteria"], detail["criteria"]);
    toggle(&s, true, 1).await?;
    count(&s, &epic, 2, 5).await?;
    toggle(&s, false, 1).await?;
    let detail = count(&s, &epic, 1, 5).await?;
    let root = detail["specs"]
        .as_array()
        .unwrap()
        .iter()
        .find(|n| n["node_id"] == "criteria-spec")
        .unwrap();
    assert_eq!(root["children"][0]["criteria"][0]["confirmed"], true);
    s.agent.terminate().await?;
    let db = rusqlite::Connection::open(s.sandbox.data.join("agent-runtime/btcc.sqlite"))?;
    let actor: String = db.query_row("SELECT confirmed_by FROM canon_criterion_checks WHERE node_id='child-spec' AND criterion_id='VB-03'", [], |r| r.get(0))?;
    let actor: Value = serde_json::from_str(&actor)?;
    assert_eq!(actor["person"], "app-user");
    assert_eq!(actor["via"], "app");
    drop(db);
    s.finish().await
}
