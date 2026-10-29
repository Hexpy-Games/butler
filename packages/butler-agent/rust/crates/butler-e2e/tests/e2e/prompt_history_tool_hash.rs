//! Approval-mode tool schema stays pinned across catalog-description changes.
use super::*;

#[tokio::test]
async fn approval_tool_bundle_matches_golden() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    let (url, stub, server) = provider::start(false).await?;
    let setup = Setup::new("PROMPT-APPROVAL-TOOLS")?
        .access(butler_e2e::e2e::scenario::Access::AskAlways)
        .stub_cassette(Cassette::load("TOOL-01")?)
        .env("BUTLER_CHATGPT_API_BASE_URL", format!("{url}/v1"));
    let placeholders = setup.placeholders.clone();
    let s = setup.start().await?;
    butler_e2e::e2e::fixtures::default_project_folder(&s).await?;
    let (id, turn) = s
        .turn("general", "Inspect the current workspace context.")
        .await?;
    assert_eq!(turn["state"], "delivered");
    let request = stub.requests.lock().unwrap()[0].clone();
    let captured = golden::capture(&s.sandbox.data, &id, &[request], &placeholders)?;
    let expected: Value = serde_json::from_str(include_str!(
        "../../fixtures/prompt-history/tool-hashes.json"
    ))?;
    assert_eq!(captured["frames"][0]["tools_sha256"], expected["resume"]);
    s.finish().await?;
    server.abort();
    Ok(())
}
