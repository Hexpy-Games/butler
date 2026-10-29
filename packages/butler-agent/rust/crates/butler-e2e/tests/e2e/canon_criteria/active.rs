use super::*;
#[tokio::test]
async fn tree_toggle_count_and_mcp_follow_active_revision_until_activation()
-> Result<(), HarnessError> {
    butler_e2e::gate!();
    let (mut s, _, epic) = fixture("CC-active").await?;
    toggle(&s, true, 1).await?;
    super::super::canon_mcp::trust(&s).await?;
    let baseline =
        super::super::canon_mcp::call(&s, "canon_get_epic", json!({"epic_id":epic})).await?;
    s.agent.terminate().await?;
    let mut db = rusqlite::Connection::open(s.sandbox.data.join("agent-runtime/btcc.sqlite"))?;
    let tx = store::Transaction::new(db.transaction()?).map_err(|e| err(&e))?;
    let hash = store::put_body(&tx, "New unpublished criterion").map_err(|e| err(&e))?;
    let ctx = store::Context {
        now: 2,
        actor: json!({"person":"app-user","via":"app"}),
    };
    store::publish_spec(
        &tx,
        &ctx,
        "criteria-spec",
        2,
        &store::Publication {
            revision: 2,
            body_hash: hash,
            parser_version: "markdown".into(),
            criteria: vec![store::Criterion {
                id: "NEW-01".into(),
                part_id: "기록".into(),
                text: "새 기준".into(),
            }],
        },
    )
    .map_err(|e| err(&e))?;
    tx.commit()?;
    drop(db);
    s.restart().await?;
    let detail = count(&s, &epic, 1, 2).await?;
    assert_eq!(detail["specs"][0]["active_revision"], 1);
    assert_eq!(detail["specs"][0]["latest_revision"], 2);
    assert_eq!(detail["specs"][0]["criteria"].as_array().unwrap().len(), 2);
    let external =
        super::super::canon_mcp::call(&s, "canon_get_epic", json!({"epic_id":epic})).await?;
    assert_eq!(
        external["specs"][0]["criteria"],
        baseline["specs"][0]["criteria"]
    );
    let spec =
        super::super::canon_mcp::call(&s, "canon_get_spec", json!({"spec_id":"criteria-spec"}))
            .await?;
    let criterion_ids = |criteria: &Value| {
        criteria
            .as_array()
            .unwrap()
            .iter()
            .map(|criterion| criterion["criterion_id"].as_str().unwrap().to_owned())
            .collect::<Vec<_>>()
    };
    let epic_ids = criterion_ids(&external["specs"][0]["criteria"]);
    let spec_ids = criterion_ids(&spec["criteria"]);
    assert_eq!(epic_ids, spec_ids);
    assert_eq!(epic_ids, ["VB-03", "VB-04"]);
    assert_eq!(spec["criteria"], external["specs"][0]["criteria"]);
    let reply =
        s.gw.post(
            "/canon/specs/criteria-spec/criteria/VB-03",
            json!({"confirmed":false,"expected_revision":3}),
        )
        .await?;
    assert_eq!(reply.status, 200, "{}", reply.text);
    count(&s, &epic, 0, 2).await?;
    let unavailable =
        s.gw.post(
            "/canon/specs/criteria-spec/criteria/NEW-01",
            json!({"confirmed":true,"expected_revision":3}),
        )
        .await?;
    assert_eq!(unavailable.status, 404, "{}", unavailable.text);
    s.agent.terminate().await?;
    let mut db = rusqlite::Connection::open(s.sandbox.data.join("agent-runtime/btcc.sqlite"))?;
    let tx = store::Transaction::new(db.transaction()?).map_err(|e| err(&e))?;
    store::activate_spec(&tx, &ctx, "criteria-spec", 3, Some(1), 2).map_err(|e| err(&e))?;
    tx.commit()?;
    drop(db);
    s.restart().await?;
    let detail = count(&s, &epic, 0, 1).await?;
    assert_eq!(detail["specs"][0]["criteria"][0]["criterion_id"], "NEW-01");
    s.finish().await
}
