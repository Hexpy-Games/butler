use super::super::canon_registration::stub;
use super::*;
use butler_e2e::e2e::cassette::Cassette;
#[tokio::test]
async fn cn_11_chat_proposal_activity_never_reaches_mcp() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    let (url, script, server) = stub::start().await?;
    let mut s = Setup::new("CN-11-PRIVACY")?
        .data_folder_token()
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
        json!({"project":project,"title":"Shared design"}),
    )
    .await?;
    let id = epic["id"].as_str().unwrap();
    writes::seed_spec(&mut s, id, &project).await?;
    let chat =
        s.gw.post("/sessions", json!({"title":"Private chat","kind":"chat"}))
            .await?
            .data()["session"]["id"]
            .as_str()
            .unwrap()
            .to_owned();
    let message = "Review this design";
    stub::arm(
        &script,
        message,
        vec![(
            "canon_propose",
            json!({"project_id":project,"summary":"PRIVATE_CHAT_DRAFT_719","changes":[{"op":"spec.edit","id":"shared-spec","expected_revision":0,"body":"Private design"}]}),
        )],
    );
    let (_, turn) = s.turn(&chat, message).await?;
    assert_eq!(
        butler_e2e::e2e::gateway::turn_state(&turn),
        "delivered",
        "{turn}"
    );
    let app = s.gw.get(&format!("/canon/epics/{id}")).await?;
    assert!(
        app.data()["activity"]
            .as_array()
            .unwrap()
            .iter()
            .any(|r| r["summary"] == "PRIVATE_CHAT_DRAFT_719"),
        "{}",
        app.text
    );
    call(&s, "canon_get_epic", json!({"epic_id":id})).await?;
    call(&s, "canon_list", json!({"project":project})).await?;
    server.abort();
    s.finish().await
}
