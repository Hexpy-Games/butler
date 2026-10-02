//! Stub owner routes used by the Settings Memory page (browser flow is smoke-tested).
#![allow(
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::panic,
    dead_code,
    reason = "E2E assertions and shared helpers"
)]
#[path = "feedback/support.rs"]
mod feedback_support;
use butler_e2e::e2e::HarnessError;
use feedback_support::*;
use serde_json::json;
#[tokio::test]
async fn feedback_page_list_delete_reset_keeps_chats_and_instructions() -> Result<(), HarnessError>
{
    butler_e2e::gate!();
    use butler_e2e::e2e::scenario::{Fixture, Setup};
    let setup = Setup::new("FEEDBACK-PAGE")?
        .fixture(Fixture::Empty)
        .stub_cassette(stub()?);
    let rules = setup.sandbox.data.join("cognition/memory/rules");
    std::fs::create_dir_all(&rules)?;
    std::fs::write(rules.join("global.md"), "Keep this existing instruction.")?;
    std::fs::write(rules.join("INDEX.md"), "- [global](global.md)\n")?;
    let s = start_setup(setup).await?;
    let first = support::tool(&s, "general", "Correct globally", "record_user_feedback").await?;
    support::tool(&s, "general", "Correct session", "record_user_feedback").await?;
    let chats = s.gw.get("/sessions").await?.data().clone();
    let instructions = s.gw.get("/memory/instructions").await?.data().clone();
    assert_eq!(instructions["instructions"].as_array().unwrap().len(), 1);
    let list = s.gw.get("/memory/feedback").await?;
    assert_eq!(list.status, 200, "{}", list.text);
    assert_eq!(list.data()["entries"].as_array().unwrap().len(), 2);
    assert!(
        list.data()["entries"]
            .as_array()
            .unwrap()
            .iter()
            .all(|e| e["text"].as_str().is_some_and(|t| !t.is_empty()) && e["state"] == "active")
    );
    let reply =
        s.gw.delete(&format!(
            "/memory/feedback/{}",
            first["feedback"].as_str().unwrap()
        ))
        .await?;
    assert_eq!(reply.status, 200, "{}", reply.text);
    let list = s.gw.get("/memory/feedback").await?;
    assert_eq!(
        list.data()["entries"]
            .as_array()
            .unwrap()
            .iter()
            .filter(|e| e["state"] == "active")
            .count(),
        1
    );
    let reset = s.gw.post("/memory/feedback/reset", json!({})).await?;
    assert_eq!(reset.status, 200, "{}", reset.text);
    assert!(
        s.gw.get("/memory/feedback").await?.data()["entries"]
            .as_array()
            .unwrap()
            .iter()
            .all(|e| e["state"] != "active")
    );
    assert_eq!(s.gw.get("/sessions").await?.data(), &chats);
    assert_eq!(
        s.gw.get("/memory/instructions").await?.data(),
        &instructions
    );
    s.finish().await
}
