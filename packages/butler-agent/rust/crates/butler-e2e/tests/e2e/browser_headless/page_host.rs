//! The gpui shell is the Agent's page host for the life of the App, not of its window.
#![allow(
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::panic,
    reason = "test assertions"
)]
use super::support::{admin, call, open, publish, selected, setup, shell};
use butler_e2e::e2e::HarnessError;
use serde_json::json;

#[tokio::test]
async fn the_page_host_outlives_the_window() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    butler_e2e::skip_unless!(
        shell() && selected(),
        "BUTLER_E2E_BROWSER_BACKEND=shell not set"
    );
    let mut s = setup("BROWSER-PAGE-HOST-WINDOW-CLOSED")?.start().await?;
    let url = publish(&s).await?;
    let admin = admin(&s);
    let opened = open(&admin, "general", &url).await?;
    assert_eq!(opened["status"], "ok", "{opened}");
    s.shell(&["close-window"]).await?;
    s.attached().await?;
    let observed = call(&admin, "general", "tab.observe", &opened["tab"], json!({})).await?;
    assert_eq!(observed["status"], "ok", "{observed}");
    assert!(
        observed["nodes"].as_array().is_some_and(|n| !n.is_empty()),
        "{observed}"
    );
    call(&admin, "general", "tab.close", &opened["tab"], json!({})).await?;
    s.finish().await
}

#[tokio::test]
async fn the_page_host_returns_after_the_agent_restarts() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    butler_e2e::skip_unless!(
        shell() && selected(),
        "BUTLER_E2E_BROWSER_BACKEND=shell not set"
    );
    let mut s = setup("BROWSER-PAGE-HOST-AGENT-RESTART")?.start().await?;
    s.shell(&["close-window"]).await?;
    s.restart().await?;
    s.attached().await?;
    let admin = admin(&s);
    let url = publish(&s).await?;
    let opened = open(&admin, "general", &url).await?;
    assert_eq!(opened["status"], "ok", "{opened}");
    let observed = call(&admin, "general", "tab.observe", &opened["tab"], json!({})).await?;
    assert_eq!(observed["status"], "ok", "{observed}");
    s.finish().await
}
