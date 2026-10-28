use super::super::canon_registration::stub;
use super::*;
use butler_e2e::e2e::{cassette::Cassette, scenario::Access};
async fn status(s: &Scenario, id: &str, status: &str) -> Result<Value, HarnessError> {
    let current = call(s, "canon_get_epic", json!({"epic_id":id})).await?;
    let updated = call(
        s,
        "canon_update_epic_status",
        json!({"epic_id":id,"expected_revision":current["revision"],"status":status}),
    )
    .await?;
    assert_eq!(updated["status"], status, "{updated}");
    assert!(updated.get("agent").is_none());
    Ok(updated)
}
async fn mark(s: &Scenario, project: &str, id: &str, expected: Value) -> Result<(), HarnessError> {
    let epic = s.gw.get(&format!("/canon/epics/{id}")).await?;
    assert_eq!(epic.data()["agent"], expected, "{}", epic.text);
    let board = s.gw.get(&format!("/projects/{project}/canon")).await?;
    assert_eq!(board.data()["backlog"][0]["agent"], expected);
    let sidebar =
        s.gw.get(&format!("/projects/{project}/canon/sidebar"))
            .await?;
    assert_eq!(sidebar.data()["groups"][0]["rows"][0]["agent"], expected);
    Ok(())
}
#[tokio::test]
async fn cn_14_agent_mark_follows_latest_status_change() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    let (url, script, server) = stub::start().await?;
    let s = Setup::new("CN-14")?
        .data_folder_token()
        .access(Access::Auto)
        .stub_cassette(Cassette::load("TOOL-01")?)
        .env("BUTLER_CHATGPT_API_BASE_URL", url)
        .env("BUTLER_E2E_HOLD_MEMORY_BOOTSTRAP", "1")
        .start()
        .await?;
    butler_e2e::e2e::fixtures::default_project_folder(&s).await?;
    let project = project(&s).await?;
    trust(&s).await?;
    let epic = call(
        &s,
        "canon_create_epic",
        json!({"project":project,"title":"Shared work","assign_to_me":true}),
    )
    .await?;
    let id = epic["id"].as_str().unwrap();
    let expected = json!({"person":"app-user","via":"Claude Code","client":"claude-code"});
    let current = status(&s, id, "in_progress").await?;
    mark(&s, &project, id, expected.clone()).await?;
    let comment =
        s.gw.post(
            &format!("/canon/epics/{id}/comments"),
            json!({"body":"Person review comment"}),
        )
        .await?;
    assert_eq!(comment.status, 200, "{}", comment.text);
    mark(&s, &project, id, expected.clone()).await?;
    let reply =
        s.gw.patch(
            &format!("/canon/epics/{id}"),
            json!({"expected_revision":current["revision"],"status":"in_review"}),
        )
        .await?;
    assert_eq!(reply.status, 200, "{}", reply.text);
    mark(&s, &project, id, Value::Null).await?;
    let current = status(&s, id, "in_progress").await?;
    mark(&s, &project, id, expected.clone()).await?;
    let chat =
        s.gw.post("/sessions", json!({"title":"Status review","kind":"chat"}))
            .await?
            .data()["session"]["id"]
            .as_str()
            .unwrap()
            .to_owned();
    let message = "Move this Epic into review";
    stub::arm(
        &script,
        message,
        vec![(
            "canon_propose",
            json!({"project_id":project,"summary":"Review ready","changes":[{"op":"epic.edit","id":id,"expected_revision":current["revision"],"status":"in_review"}]}),
        )],
    );
    let (_, turn) = s.turn(&chat, message).await?;
    assert_eq!(
        butler_e2e::e2e::gateway::turn_state(&turn),
        "delivered",
        "{turn}"
    );
    let detail = s.gw.get(&format!("/canon/epics/{id}")).await?;
    assert_eq!(
        detail.data()["canon_status"],
        "in_review",
        "{}",
        detail.text
    );
    assert!(
        detail.data()["activity"]
            .as_array()
            .unwrap()
            .iter()
            .any(|a| a["kind"] == "status" && a["actor"]["via"] == "butler")
    );
    mark(&s, &project, id, Value::Null).await?;
    status(&s, id, "in_progress").await?;
    mark(&s, &project, id, expected).await?;
    status(&s, id, "done").await?;
    mark(&s, &project, id, Value::Null).await?;
    server.abort();
    s.finish().await
}
