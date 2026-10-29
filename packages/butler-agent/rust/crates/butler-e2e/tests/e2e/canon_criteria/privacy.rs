use super::*;
fn no_decisions(value: &Value) {
    match value {
        Value::Object(object) => {
            assert!(!object.contains_key("confirmed"), "{value}");
            if let Some(criteria) = object.get("criteria") {
                assert!(criteria.is_array(), "criteria count escaped: {value}");
            }
            if let Some(kind) = object.get("kind").and_then(Value::as_str) {
                assert!(!kind.starts_with("criterion_"), "{value}");
            }
            for value in object.values() {
                no_decisions(value);
            }
        }
        Value::Array(array) => {
            for value in array {
                no_decisions(value);
            }
        }
        _ => {}
    }
}
pub(super) async fn delegated(s: &Scenario, path: &str) -> Result<Value, HarnessError> {
    let reply =
        s.gw.send_with(
            reqwest::Method::GET,
            path,
            None,
            Some(&s.gw.token),
            &[
                ("X-Butler-Delegate-Client", "Claude Code"),
                ("X-Butler-Delegate-Client-Name", "claude-code"),
            ],
        )
        .await?;
    assert_eq!(reply.status, 200, "{}", reply.text);
    no_decisions(reply.data());
    Ok(reply.data().clone())
}
pub(super) async fn assert_surfaces(
    s: &Scenario,
    project: &str,
    plan: &str,
    epic: &str,
) -> Result<(), HarnessError> {
    super::super::canon_mcp::trust(s).await?;
    for path in [
        format!("/canon/list?project={project}"),
        format!("/canon/plans/{plan}"),
        format!("/projects/{project}/canon"),
        format!("/canon/epics/{epic}"),
        format!("/canon/epics/{epic}/activity"),
    ] {
        delegated(s, &path).await?;
    }
    for (name, args) in [
        ("canon_list", json!({"project":project})),
        ("canon_list", json!({"project":project,"plan_id":plan})),
        ("canon_get_epic", json!({"epic_id":epic})),
    ] {
        no_decisions(&super::super::canon_mcp::call(s, name, args).await?);
    }
    Ok(())
}
#[tokio::test]
async fn criterion_activity_is_filtered_before_mcp_paging() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    let (mut s, _, epic) = fixture("CC-privacy-pages").await?;
    super::super::canon_mcp::trust(&s).await?;
    s.agent.terminate().await?;
    let mut db = rusqlite::Connection::open(s.sandbox.data.join("agent-runtime/btcc.sqlite"))?;
    let tx = store::Transaction::new(db.transaction()?).map_err(|e| err(&e))?;
    let ctx = store::Context {
        now: 2,
        actor: json!({"person":"app-user","via":"app"}),
    };
    for i in 0..55 {
        store::activity::append(&tx, &ctx, &epic, "comment", &format!("Comment {i}"), None)
            .map_err(|e| err(&e))?;
        for kind in ["criterion_confirmed", "criterion_unconfirmed"] {
            store::activity::append(&tx, &ctx, "criteria-spec", kind, "VB-03", None)
                .map_err(|e| err(&e))?;
        }
    }
    tx.commit()?;
    drop(db);
    s.restart().await?;
    let external =
        super::super::canon_mcp::call(&s, "canon_get_epic", json!({"epic_id":epic})).await?;
    no_decisions(&external);
    assert_eq!(external["activity"].as_array().unwrap().len(), 50);
    let before = external["activity_before"].as_i64().unwrap();
    let older = delegated(&s, &format!("/canon/epics/{epic}/activity?before={before}")).await?;
    assert!(older["activity_before"].is_null());
    let all = external["activity"]
        .as_array()
        .unwrap()
        .iter()
        .chain(older["activity"].as_array().unwrap());
    let comments = all
        .filter(|r| r["kind"] == "comment")
        .map(|r| r["summary"].as_str().unwrap())
        .collect::<Vec<_>>();
    assert_eq!(
        comments,
        (0..55)
            .rev()
            .map(|i| format!("Comment {i}"))
            .collect::<Vec<_>>()
    );
    let app = s.gw.get(&format!("/canon/epics/{epic}")).await?;
    assert!(
        app.data()["activity"]
            .as_array()
            .unwrap()
            .iter()
            .any(|r| r["kind"].as_str().unwrap().starts_with("criterion_"))
    );
    s.finish().await
}
