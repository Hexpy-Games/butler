//! Human criterion decisions over the app API; no model calls.
#![allow(clippy::unwrap_used, reason = "test assertions")]
use butler_canon::store;
use butler_e2e::e2e::{
    HarnessError,
    scenario::{Scenario, Setup},
};
use serde_json::{Value, json};
mod active;
mod revisions;
mod tree;

fn err(e: &store::Error) -> HarnessError {
    HarnessError(e.to_string())
}
async fn fixture(label: &str) -> Result<(Scenario, String, String), HarnessError> {
    let mut s = Setup::new(label)?.data_folder_token().start().await?;
    let project =
        s.gw.post(
            "/projects",
            json!({"source":"scratch","display_name":"명세 확인"}),
        )
        .await?;
    assert_eq!(project.status, 201, "{}", project.text);
    let project = project.data()["project"]["id"].as_str().unwrap().to_owned();
    let epic =
        s.gw.post(
            &format!("/projects/{project}/canon/epics"),
            json!({"title":"검토 기준 정리","assignee":"app-user"}),
        )
        .await?;
    assert_eq!(epic.status, 201, "{}", epic.text);
    let epic = epic.data()["id"].as_str().unwrap().to_owned();
    s.agent.terminate().await?;
    let mut db = rusqlite::Connection::open(s.sandbox.data.join("agent-runtime/btcc.sqlite"))?;
    let tx = store::Transaction::new(db.transaction()?).map_err(|e| err(&e))?;
    let ctx = store::Context {
        now: 1,
        actor: json!({"person":"app-user","via":"app"}),
    };
    store::create_spec_node(
        &tx,
        &ctx,
        &store::NewSpecNode {
            id: "criteria-spec".into(),
            scope_kind: butler_canon::work_types::ScopeKind::Project,
            scope_ref: project.clone(),
            epic_id: Some(epic.clone()),
            parent_node_id: None,
            concern_id: "검토 기준".into(),
        },
        &store::Registration::Canon(store::UserAct::new("app-user")),
    )
    .map_err(|e| err(&e))?;
    tx.execute(
        "UPDATE canon_epics SET spec_node_id='criteria-spec' WHERE id=?1",
        [&epic],
    )?;
    tx.commit()?;
    drop(db);
    publish(
        &s,
        1,
        &[
            ("VB-03", "변경 내용을 확인할 수 있다"),
            ("VB-04", "확인한 사람을 기록한다"),
        ],
    )?;
    s.restart().await?;
    Ok((s, project, epic))
}
fn publish(s: &Scenario, revision: i64, criteria: &[(&str, &str)]) -> Result<(), HarnessError> {
    let mut db = rusqlite::Connection::open(s.sandbox.data.join("agent-runtime/btcc.sqlite"))?;
    let tx = store::Transaction::new(db.transaction()?).map_err(|e| err(&e))?;
    let ctx = store::Context {
        now: revision,
        actor: json!({"person":"app-user","via":"app"}),
    };
    publish_node(&tx, &ctx, "criteria-spec", revision, criteria)?;
    tx.commit()?;
    Ok(())
}
fn publish_node(
    tx: &store::Transaction<'_>,
    ctx: &store::Context,
    node: &str,
    revision: i64,
    criteria: &[(&str, &str)],
) -> Result<(), HarnessError> {
    let expected: i64 = tx.query_row(
        "SELECT revision FROM canon_spec_nodes WHERE node_id=?1",
        [node],
        |r| r.get(0),
    )?;
    let active: Option<i64> = tx.query_row(
        "SELECT active_revision FROM canon_spec_nodes WHERE node_id=?1",
        [node],
        |r| r.get(0),
    )?;
    let body = criteria
        .iter()
        .map(|(id, text)| format!("- {id} {text}"))
        .collect::<Vec<_>>()
        .join("\n");
    let hash = store::put_body(tx, &body).map_err(|e| err(&e))?;
    store::publish_spec(
        tx,
        ctx,
        node,
        expected,
        &store::Publication {
            revision,
            body_hash: hash,
            parser_version: "markdown".into(),
            criteria: criteria
                .iter()
                .map(|(id, text)| store::Criterion {
                    id: (*id).into(),
                    part_id: "표시".into(),
                    text: (*text).into(),
                })
                .collect(),
        },
    )
    .map_err(|e| err(&e))?;
    store::activate_spec(tx, ctx, node, expected + 1, active, revision).map_err(|e| err(&e))?;
    Ok(())
}
async fn toggle(s: &Scenario, confirmed: bool, revision: i64) -> Result<(), HarnessError> {
    let reply =
        s.gw.post(
            "/canon/specs/criteria-spec/criteria/VB-03",
            json!({"confirmed":confirmed,"expected_revision":revision * 2}),
        )
        .await?;
    assert_eq!(reply.status, 200, "{}", reply.text);
    assert_eq!(reply.data()["confirmed"], confirmed);
    Ok(())
}
async fn count(
    s: &Scenario,
    epic: &str,
    confirmed: u64,
    total: u64,
) -> Result<Value, HarnessError> {
    let reply = s.gw.get(&format!("/canon/epics/{epic}")).await?;
    assert_eq!(reply.status, 200, "{}", reply.text);
    assert_eq!(
        reply.data()["criteria"],
        json!({"confirmed":confirmed,"total":total})
    );
    Ok(reply.data().clone())
}
#[tokio::test]
async fn app_toggle_counts_activity_permissions_and_revision_conflict() -> Result<(), HarnessError>
{
    butler_e2e::gate!();
    let (s, project, epic) = fixture("CC-toggle").await?;
    toggle(&s, true, 1).await?;
    let detail = count(&s, &epic, 1, 2).await?;
    assert_eq!(detail["specs"][0]["criteria"][0]["confirmed"], true);
    let activity = &detail["activity"][0];
    assert_eq!(activity["kind"], "criterion_confirmed");
    assert_eq!(activity["summary"], "VB-03");
    assert_eq!(activity["actor"]["person"], "app-user");
    assert_eq!(activity["actor"]["via"], "app");
    toggle(&s, true, 1).await?; // Duplicate decisions create no extra activity.
    assert_eq!(
        count(&s, &epic, 1, 2).await?["activity"],
        detail["activity"]
    );
    let overview = s.gw.get(&format!("/projects/{project}/canon")).await?;
    assert_eq!(
        overview.data()["backlog"][0]["criteria"],
        detail["criteria"]
    );
    let list = s.gw.get(&format!("/canon/list?project={project}")).await?;
    assert_eq!(list.data()["epics"][0]["criteria"], detail["criteria"]);
    let sidebar =
        s.gw.get(&format!("/projects/{project}/canon/sidebar"))
            .await?;
    assert_eq!(sidebar.status, 200, "{}", sidebar.text);
    assert_eq!(
        sidebar.data()["groups"][0]["rows"]
            .as_array()
            .unwrap()
            .len(),
        1
    );
    assert_eq!(
        sidebar.data()["groups"][0]["rows"][0]["criteria"],
        detail["criteria"]
    );
    let plan =
        s.gw.post(
            &format!("/projects/{project}/canon/plans"),
            json!({"title":"검토"}),
        )
        .await?;
    assert_eq!(plan.status, 201, "{}", plan.text);
    let plan = plan.data()["id"].as_str().unwrap();
    let moved =
        s.gw.patch(
            &format!("/canon/epics/{epic}"),
            json!({"expected_revision":detail["revision"],"plan_id":plan}),
        )
        .await?;
    assert_eq!(moved.status, 200, "{}", moved.text);
    assert_eq!(
        s.gw.get(&format!("/canon/plans/{plan}")).await?.data()["works"][0]["criteria"],
        detail["criteria"]
    );
    let stale =
        s.gw.post(
            "/canon/specs/criteria-spec/criteria/VB-03",
            json!({"confirmed":false,"expected_revision":0}),
        )
        .await?;
    assert_eq!(stale.status, 409, "{}", stale.text);
    assert_eq!(stale.error_code(), Some("conflict"));
    let denied =
        s.gw.send_with(
            reqwest::Method::POST,
            "/canon/specs/criteria-spec/criteria/VB-03",
            Some(json!({"confirmed":false,"expected_revision":2}).to_string()),
            Some(&s.gw.token),
            &[
                ("X-Butler-Delegate-Client", "External editor"),
                ("X-Butler-Delegate-Client-Name", "editor"),
            ],
        )
        .await?;
    assert_eq!(denied.status, 403, "{}", denied.text);
    assert_eq!(denied.error_code(), Some("permission"));
    toggle(&s, false, 1).await?;
    let detail = count(&s, &epic, 0, 2).await?;
    assert_eq!(detail["activity"][0]["kind"], "criterion_unconfirmed");
    // MCP projection stays unchanged: no count and no confirmation fields.
    super::canon_mcp::trust(&s).await?;
    let external = super::canon_mcp::call(&s, "canon_get_epic", json!({"epic_id":epic})).await?;
    assert!(external.get("criteria").is_none());
    assert!(!external.to_string().contains("\"confirmed\""));
    s.finish().await
}
