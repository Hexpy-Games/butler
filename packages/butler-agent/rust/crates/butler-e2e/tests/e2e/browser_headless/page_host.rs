//! The gpui shell is the Agent's page host for the life of the App, not of its window.
#![allow(
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::panic,
    reason = "test assertions"
)]
use super::support::{admin, call, open, publish, selected, setup, shell};
use crate::shell_app::live_turns::complete_onboarding;
use butler_e2e::e2e::HarnessError;
use serde_json::{Value, json};

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

#[tokio::test]
async fn the_page_host_starts_cef_on_first_use_without_a_window() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    butler_e2e::skip_unless!(
        shell() && selected(),
        "BUTLER_E2E_BROWSER_BACKEND=shell not set"
    );
    let mut s = setup("BROWSER-PAGE-HOST-LAZY")?.start().await?;
    s.shell(&["close-window"]).await?;
    s.attached().await?;
    // CEF creates its profile folder when it starts (`cef/config.rs`).
    let profile = s.sandbox.data.join("app/browser/profile");
    assert!(!profile.exists(), "CEF started before any browser use");
    let admin = admin(&s);
    // A public address that passes the egress guard without DNS (TEST-NET-1: never routed).
    let site = json!({"site":"192.0.2.1"});
    let granted = call(&admin, "general", "signin.grant", &Value::Null, site).await?;
    assert_eq!(granted["status"], "ok", "{granted}");
    // Only a page host has signed-in pages (headless refuses them: `signed_in_unavailable`); it
    // opened this one, whose unrouted address never loads.
    let args = json!({"url":"https://192.0.2.1/account","signed_in":true});
    let opened = call(&admin, "general", "tab.open", &Value::Null, args).await?;
    assert_eq!(opened["reason"], "navigation_failed", "{opened}");
    assert!(profile.is_dir(), "CEF started on the first page");
    s.finish().await
}

#[tokio::test]
async fn a_waiting_hand_off_shows_the_band_and_gives_back() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    butler_e2e::skip_unless!(
        shell() && selected(),
        "BUTLER_E2E_BROWSER_BACKEND=shell not set"
    );
    let mut s = setup("BROWSER-PAGE-HOST-HAND-OFF")?.start().await?;
    let url = publish(&s).await?;
    let admin = admin(&s);
    let opened = open(&admin, "general", &url).await?;
    assert_eq!(opened["status"], "ok", "{opened}");
    let tab = &opened["tab"];
    // A new window opens the workspace once the onboarding is done.
    complete_onboarding(&s.gw).await?;
    s.shell(&[
        "close-window",
        "tray-open",
        "wait-anchor composer",
        "browser",
        "wait-anchor browser-area",
    ])
    .await?;
    // The Agent hands the tab to the user: the band shows, and the Agent is locked out.
    let waited = call(
        &admin,
        "general",
        "tab.wait",
        tab,
        json!({"reason":"other"}),
    )
    .await?;
    assert_eq!(waited["status"], "user_control", "{waited}");
    s.shell(&["wait-anchor browser-band", "wait-anchor browser-control"])
        .await?;
    let locked = call(&admin, "general", "tab.observe", tab, json!({})).await?;
    assert_eq!(locked["reason"], "user_control", "{locked}");
    // Give back from the band: the band goes and the Agent has the page again.
    s.shell(&["click browser-control", "wait-no-anchor browser-band"])
        .await?;
    let observed = call(&admin, "general", "tab.observe", tab, json!({})).await?;
    assert_eq!(observed["status"], "ok", "{observed}");
    call(&admin, "general", "tab.close", tab, json!({})).await?;
    s.finish().await
}
