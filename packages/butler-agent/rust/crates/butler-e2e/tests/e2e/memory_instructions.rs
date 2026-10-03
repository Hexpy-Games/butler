//! Authenticated Settings actions use the instruction owner without a chat turn.
#![allow(
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::panic,
    reason = "E2E assertions"
)]
use butler_e2e::e2e::{
    HarnessError,
    cassette::Cassette,
    fixtures,
    scenario::{Fixture, Setup},
};
use serde_json::json;
#[path = "support/memory_fixture.rs"]
mod memory_fixture;
const ASK: &str = "Say hello in one sentence.";
const TEXT: &str = "For every answer use the phrase mango-settings-5317.";

#[tokio::test]
async fn settings_instruction_routes_preserve_profile_separation_and_forget_in_next_prompt()
-> Result<(), HarnessError> {
    butler_e2e::gate!();
    let setup = Setup::new("MEM-INSTRUCTIONS")?.fixture(Fixture::Empty);
    fixtures::onboarding_complete(&setup.sandbox.data)?;
    fixtures::scheduler_ran_today(&setup.sandbox.data, "2026-10-03T00:00:00.000Z")?;
    memory_fixture::initialize_empty(&setup.sandbox.data)?;
    let rules = setup.sandbox.data.join("cognition/memory/rules");
    std::fs::create_dir_all(&rules)?;
    std::fs::write(rules.join("global.md"), TEXT)?;
    std::fs::write(rules.join("project.md"), "Keep project-only instructions.")?;
    std::fs::write(
        rules.join("INDEX.md"),
        "- [global](global.md)\n- [project](project.md)\n",
    )?;
    use sha2::{Digest, Sha256};
    let text = "Keep project-only instructions.";
    let hash = format!("{:x}", Sha256::digest(text.as_bytes()));
    std::fs::write(rules.join("project.source.json"), json!({"schema":"butler.explicit-rule-binding.v1", "state":"active", "record_id":"project", "revision":hash, "operation_id":"seed-project", "content_hash":hash, "project_id":"missing-project", "conversation_session_id":null, "conversation_message_id":null, "observed_at":"2026-10-03T00:00:00.000Z", "operations":[]}).to_string())?;
    // Supported legacy instructions are adopted read-only by the owner; all chats is the default.
    let mut cassette = Cassette::load("TURN-01")?;
    for exchange in &mut cassette.exchanges {
        exchange.request.key.user_request = ASK.into();
    }
    let s = setup.stub_cassette(cassette).start().await?;
    s.select_model(&s.model).await?;
    let unauthorized =
        s.gw.send_with(
            reqwest::Method::GET,
            "/memory/instructions",
            None,
            None,
            &[],
        )
        .await?;
    assert_eq!(unauthorized.status, 401);
    let list = s.gw.get("/memory/instructions").await?;
    assert_eq!(list.status, 200, "{}", list.text);
    let before = list.data()["instructions"].clone();
    assert_eq!(before.as_array().unwrap().len(), 2);
    assert!(
        !rules.join("manifest.json").exists(),
        "list must not adopt by writing"
    );
    let project = before
        .as_array()
        .unwrap()
        .iter()
        .find(|r| r["project_id"] == "missing-project")
        .unwrap();
    assert_eq!(project["scope"]["kind"], "project");
    assert!(project["scope"]["project_name"].is_null());
    let checked = s.gw.post("/memory/inventory/check", json!({})).await?;
    assert_eq!(checked.status, 200, "{}", checked.text);
    assert_eq!(checked.data()["kinds"][0]["item_count"], 2);
    let created =
        s.gw.post(
            "/projects",
            json!({"source":"scratch", "display_name":"Settings project"}),
        )
        .await?;
    assert_eq!(created.status, 201, "{}", created.text);
    let id = created.data()["project"]["id"].as_str().unwrap();
    let project_view = s.gw.get(&format!("/memory/projects/{id}")).await?;
    assert_eq!(project_view.status, 200, "{}", project_view.text);
    assert_eq!(project_view.data()["instructions"], 0);
    assert_eq!(project_view.data()["conversations"], 0);
    assert!(project_view.data()["summary_bytes"].is_null());
    assert_eq!(s.gw.get("/memory/projects/missing").await?.status, 404);
    // The App queues this draft locally, then Apply sends this exact backend action.
    let queued = json!({"profiling":{"clear_profile":true}});
    assert_eq!(
        s.gw.get("/memory/instructions").await?.data()["instructions"],
        before
    );
    let applied = s.gw.patch("/personalization", queued).await?;
    assert_eq!(applied.status, 200, "{}", applied.text);
    assert_eq!(
        s.gw.get("/memory/instructions").await?.data()["instructions"],
        before
    );
    let row = before
        .as_array()
        .unwrap()
        .iter()
        .find(|r| r["text"] == TEXT)
        .unwrap();
    let path = format!("/memory/instructions/{}", row["handle"].as_str().unwrap());
    let stale = s.gw.send(reqwest::Method::DELETE, &path, Some(json!({"expected_revision":"stale", "operation_id":uuid::Uuid::new_v4().to_string()}).to_string())).await?;
    assert_eq!(stale.status, 409);
    assert_eq!(
        s.gw.get("/memory/instructions").await?.data()["instructions"],
        before
    );
    let first = s.provider()?.requests().len();
    let (_, turn) = s.turn("general", ASK).await?;
    assert_eq!(turn["state"], "delivered", "{turn}");
    assert!(
        s.provider()?.requests()[first..]
            .iter()
            .any(|r| r["input"].to_string().contains(TEXT))
    );
    let operation = json!({"expected_revision":row["revision"], "project_id":null, "operation_id":uuid::Uuid::new_v4().to_string()}).to_string();
    let deleted =
        s.gw.send(reqwest::Method::DELETE, &path, Some(operation.clone()))
            .await?;
    assert_eq!(deleted.status, 200, "{}", deleted.text);
    let replayed =
        s.gw.send(reqwest::Method::DELETE, &path, Some(operation))
            .await?;
    assert_eq!(replayed.status, 200, "{}", replayed.text);
    assert_eq!(replayed.data()["replayed"], true);
    let remaining = s.gw.get("/memory/instructions").await?;
    assert_eq!(
        remaining.data()["instructions"].as_array().unwrap().len(),
        1
    );
    let first = s.provider()?.requests().len();
    let (_, turn) = s.turn("general", ASK).await?;
    assert_eq!(turn["state"], "delivered", "{turn}");
    let requests = s.provider()?.requests();
    assert!(requests.len() > first);
    assert!(
        requests[first..]
            .iter()
            .all(|r| !r["input"].to_string().contains(TEXT))
    );
    let project_path = format!(
        "/memory/instructions/{}",
        project["handle"].as_str().unwrap()
    );
    let reply = s.gw.send(reqwest::Method::DELETE, &project_path, Some(json!({"expected_revision":project["revision"], "project_id":project["project_id"], "operation_id":uuid::Uuid::new_v4().to_string()}).to_string())).await?;
    assert_eq!(reply.status, 200, "{}", reply.text);
    assert_eq!(
        s.gw.get("/memory/instructions").await?.data()["instructions"],
        json!([])
    );
    s.finish().await?;
    refused_legacy()
}

fn refused_legacy() -> Result<(), HarnessError> {
    let setup = Setup::new("MEM-INSTRUCTIONS-LEGACY")?;
    let data = &setup.sandbox.data;
    std::fs::create_dir_all(data.join("app-server"))?;
    let file = data.join("app-server/butler-client.sqlite");
    std::fs::write(&file, b"legacy")?;
    let output = butler_e2e::e2e::agent::Launch::new(&setup.sandbox)?
        .command()
        .stdin(std::process::Stdio::null())
        .output()?;
    assert!(!output.status.success());
    assert!(String::from_utf8_lossy(&output.stderr).contains("legacy data folder is unsupported"));
    assert_eq!(std::fs::read(&file)?, b"legacy");
    assert_eq!(std::fs::read_dir(data)?.count(), 1);
    Ok(())
}
