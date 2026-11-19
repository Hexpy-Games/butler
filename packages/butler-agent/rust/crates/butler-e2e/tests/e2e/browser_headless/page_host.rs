//! The gpui shell is the Agent's page host for the life of the App, not of its window.
#![allow(
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::panic,
    reason = "test assertions"
)]
use super::support::{admin, call, node, open, publish, selected, setup, shell};
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
    // An unrouted address fails as a refusal (`navigation_failed`) or a connect hang (`timeout`).
    let reason = opened["reason"].as_str().unwrap_or_default();
    assert!(matches!(reason, "navigation_failed" | "timeout"), "{opened}");
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

#[tokio::test]
async fn the_user_takes_an_idle_agent_page_by_input() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    butler_e2e::skip_unless!(
        shell() && selected(),
        "BUTLER_E2E_BROWSER_BACKEND=shell not set"
    );
    let mut s = setup("BROWSER-PAGE-HOST-USER-INPUT")?.start().await?;
    let url = publish(&s).await?;
    let admin = admin(&s);
    let opened = open(&admin, "general", &url).await?;
    assert_eq!(opened["status"], "ok", "{opened}");
    let tab = &opened["tab"];
    let page = call(&admin, "general", "tab.observe", tab, json!({})).await?;
    let rect = &node(&page, "textbox", "Search")["rect"];
    let (x, y) = (
        rect["x"].as_f64().unwrap() + rect["width"].as_f64().unwrap() / 2.0,
        rect["y"].as_f64().unwrap() + rect["height"].as_f64().unwrap() / 2.0,
    );
    // `page-click` takes page pixels, as `tab.observe` reports them.
    // The Agent's tab is the shown one; a press in its input makes the user the holder.
    complete_onboarding(&s.gw).await?;
    s.shell(&[
        "close-window",
        "tray-open",
        "wait-anchor composer",
        "browser",
        "wait-anchor browser-area",
        "click browser-tab-0",
    ])
    .await?;
    s.shell(&[&format!("page-click {x} {y}")]).await?;
    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(10);
    loop {
        let refused = call(&admin, "general", "tab.observe", tab, json!({})).await?;
        if refused["status"] == "not_dispatched" {
            assert_eq!(refused["reason"], "user_control", "{refused}");
            let listed = call(&admin, "general", "tabs.list", &Value::Null, json!({})).await?;
            let held = listed["tabs"]
                .as_array()
                .and_then(|t| t.iter().find(|t| t["id"] == *tab));
            assert_eq!(held.map(|t| &t["holder"]), Some(&json!("user")), "{listed}");
            break;
        }
        assert!(std::time::Instant::now() < deadline, "{refused}");
        tokio::time::sleep(std::time::Duration::from_millis(100)).await;
    }
    // The user's text still reaches the page.
    s.shell(&["type typed"]).await?;
    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(10);
    loop {
        let listed = call(&admin, "general", "tabs.list", &Value::Null, json!({})).await?;
        if listed["tabs"][0]["title"] == "typed" {
            break;
        }
        assert!(std::time::Instant::now() < deadline, "{listed}");
        tokio::time::sleep(std::time::Duration::from_millis(100)).await;
    }
    let rect = &node(&page, "link", "next")["rect"];
    let (x, y) = (
        rect["x"].as_f64().unwrap() + rect["width"].as_f64().unwrap() / 2.0,
        rect["y"].as_f64().unwrap() + rect["height"].as_f64().unwrap() / 2.0,
    );
    s.shell(&[&format!("page-click {x} {y}")]).await?;
    let target = reqwest::Url::parse(&url)
        .unwrap()
        .join("./popup.html")
        .unwrap();
    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(10);
    loop {
        let listed = call(&admin, "general", "tabs.list", &Value::Null, json!({})).await?;
        if listed["tabs"]
            .as_array()
            .unwrap()
            .iter()
            .any(|t| t["id"] == *tab && t["url"] == target.as_str())
        {
            break;
        }
        assert!(std::time::Instant::now() < deadline, "{listed}");
        tokio::time::sleep(std::time::Duration::from_millis(100)).await;
    }
    s.finish().await
}

#[tokio::test]
async fn the_user_takes_a_turn_held_page_by_press() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    butler_e2e::skip_unless!(
        shell() && selected(),
        "BUTLER_E2E_BROWSER_BACKEND=shell not set"
    );
    let mut s = setup("BROWSER-PAGE-HOST-TURN-HELD-PRESS")?.start().await?;
    let url = publish(&s).await?;
    let admin = admin(&s);
    let opened = open(&admin, "general", &url).await?;
    assert_eq!(opened["status"], "ok", "{opened}");
    let tab = &opened["tab"];
    let reply = admin
        .send(
            reqwest::Method::POST,
            "/internal/browser/calls",
            Some(json!({"op":"tab.observe","session":"general","tab":tab,
                "args":{"include_image":false},"turn_id":"turn-held-press"})),
            &[],
        )
        .await?;
    assert_eq!(reply.status, 200, "{}", reply.text);
    let page = reply.body;
    assert_eq!(page["status"], "ok", "{page}");
    let rect = &node(&page, "textbox", "Search")["rect"];
    let (x, y) = (
        rect["x"].as_f64().unwrap() + rect["width"].as_f64().unwrap() / 2.0,
        rect["y"].as_f64().unwrap() + rect["height"].as_f64().unwrap() / 2.0,
    );
    complete_onboarding(&s.gw).await?;
    s.shell(&[
        "close-window",
        "tray-open",
        "wait-anchor composer",
        "browser",
        "wait-anchor browser-area",
        "click browser-tab-0",
    ])
    .await?;
    s.shell(&[&format!("page-click {x} {y}")]).await?;
    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(10);
    loop {
        let listed = call(&admin, "general", "tabs.list", &Value::Null, json!({})).await?;
        let held = listed["tabs"]
            .as_array()
            .and_then(|t| t.iter().find(|t| t["id"] == *tab));
        if held.map(|t| &t["holder"]) == Some(&json!("user")) {
            break;
        }
        assert!(std::time::Instant::now() < deadline, "{listed}");
        tokio::time::sleep(std::time::Duration::from_millis(100)).await;
    }
    s.finish().await
}
