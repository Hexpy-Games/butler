//! The hidden App host (`BUTLER_E2E_BROWSER_BACKEND=hidden-app`): with the
//! App installed but not attached, its own Electron serves the browser tools
//! without a window; the App takes the channel over when it opens, and
//! without a usable Electron the headless browser serves.
#![allow(
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::panic,
    reason = "test assertions"
)]
use super::{
    backend::{attach_app, serve_app},
    support::{
        admin, browser_processes, call, hidden_app, no_chrome_cache, open, publish, setup,
        state_root,
    },
};
use butler_e2e::e2e::{HarnessError, scenario::Scenario};
use serde_json::{Value, json};
use std::{
    sync::{Arc, Mutex},
    time::Duration,
};

fn profiles(s: &Scenario) -> usize {
    std::fs::read_dir(state_root(&s.sandbox.data))
        .into_iter()
        .flatten()
        .flatten()
        .filter(|e| e.file_name().to_string_lossy().starts_with("profile-"))
        .count()
}

/// Waits until the hidden host's whole process tree and its profile are gone.
async fn host_gone(s: &Scenario, within: Duration) {
    let marker = s.sandbox.data.to_string_lossy().into_owned();
    let deadline = tokio::time::Instant::now() + within;
    while !browser_processes(&marker).is_empty() || profiles(s) > 0 {
        assert!(
            tokio::time::Instant::now() < deadline,
            "{:?}",
            browser_processes(&marker)
        );
        tokio::time::sleep(Duration::from_millis(250)).await;
    }
}

#[tokio::test]
async fn hidden_app_host_serves_and_hands_over_to_the_app() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    butler_e2e::skip_unless!(
        hidden_app(),
        "BUTLER_E2E_BROWSER_BACKEND=hidden-app not set"
    );
    let s = setup("BROWSER-HIDDEN-HANDOVER")?
        .env("BUTLER_BROWSER_HEADLESS", "")
        .env("BUTLER_APP_BUNDLED_SUPERVISOR", "1")
        .start()
        .await?;
    let admin = admin(&s);
    let marker = s.sandbox.data.to_string_lossy().into_owned();
    assert!(
        browser_processes(&marker).is_empty(),
        "no browser processes while idle"
    );

    let url = publish(&s).await?;
    // No host attached: the first tab starts the App's Electron, no Chrome.
    let opened = open(&admin, "general", &url).await?;
    assert_eq!(opened["status"], "ok", "{opened}");
    let tab = opened["tab"].clone();
    assert!(
        tab.as_str().unwrap().starts_with('t'),
        "the App executor's tab: {opened}"
    );
    assert!(
        !browser_processes(&marker).is_empty(),
        "the hidden host runs"
    );
    assert!(
        !no_chrome_cache("BROWSER-HIDDEN-HANDOVER").exists(),
        "no Chrome download was started"
    );
    // Nobody is at the App: no hand-over to the user, no signed-in profile.
    let wait = call(
        &admin,
        "general",
        "tab.wait",
        &tab,
        json!({"reason":"other"}),
    )
    .await?;
    assert_eq!(wait["reason"], "app_required", "{wait}");
    assert!(
        wait["recovery"]
            .as_str()
            .unwrap()
            .starts_with("Background browser")
    );
    let signed = call(
        &admin,
        "general",
        "tab.open",
        &Value::Null,
        json!({"url":url,"signed_in":true}),
    )
    .await?;
    assert_eq!(signed["reason"], "signed_in_unavailable", "{signed}");

    // The App opens while a call runs: it waits for that task, then takes over.
    let page = call(
        &admin,
        "general",
        "tab.observe",
        &tab,
        json!({"include_image":true}),
    )
    .await?;
    assert_eq!(page["status"], "ok", "{page}");
    let steps = json!([{"action":"wait","value":3000}]);
    let prepared = call(
        &admin,
        "general",
        "tab.prepare",
        &tab,
        json!({"observation":page["obs"],"steps":steps}),
    )
    .await?;
    assert_eq!(prepared["status"], "ok", "{prepared}");
    let acting = {
        let admin = admin.clone();
        let tab = tab.clone();
        let args =
            json!({"observation":page["obs"],"steps":steps,"prepared_steps":prepared["steps"]});
        tokio::spawn(async move { call(&admin, "general", "tab.act", &tab, args).await })
    };
    tokio::time::sleep(Duration::from_millis(500)).await;
    let busy = attach_app(&admin).await?;
    assert_eq!(busy.status(), 409);
    assert!(busy.text().await?.contains("browser_host_busy"));
    let acted = acting.await.unwrap()?;
    assert_eq!(acted["steps"][0]["status"], "completed", "{acted}");
    // The App retries its attach once a second, as its channel does.
    let mut stream = None;
    for _ in 0..20 {
        let reply = attach_app(&admin).await?;
        if reply.status() == 200 {
            stream = Some(reply);
            break;
        }
        tokio::time::sleep(Duration::from_millis(250)).await;
    }
    let ops = Arc::new(Mutex::new(Vec::new()));
    let app = tokio::spawn(serve_app(
        admin.clone(),
        stream.expect("the App attaches"),
        ops.clone(),
    ));
    host_gone(&s, Duration::from_secs(15)).await;
    assert_eq!(profiles(&s), 0, "the throwaway profile is removed");

    // New work goes to the App; the hidden host's tab went with it.
    let fresh = call(
        &admin,
        "fresh",
        "tab.open",
        &Value::Null,
        json!({"url":url}),
    )
    .await?;
    assert_eq!(fresh["tab"], "app-tab", "{fresh}");
    let old = call(&admin, "general", "tab.observe", &tab, json!({})).await?;
    assert_eq!(old["reason"], "not_your_tab", "{old}");
    assert_eq!(*ops.lock().unwrap(), vec!["tab.open".to_owned()]);
    app.abort();
    s.finish().await
}

#[tokio::test]
async fn idle_hidden_app_host_hands_over_at_once() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    butler_e2e::skip_unless!(
        hidden_app(),
        "BUTLER_E2E_BROWSER_BACKEND=hidden-app not set"
    );
    let s = setup("BROWSER-HIDDEN-IDLE-HANDOVER")?
        .env("BUTLER_BROWSER_HEADLESS", "off")
        .start()
        .await?;
    let admin = admin(&s);
    let url = publish(&s).await?;
    let opened = open(&admin, "general", &url).await?;
    assert_eq!(opened["status"], "ok", "{opened}");
    // No call in flight and no running turn: the App's first attach succeeds.
    let stream = attach_app(&admin).await?;
    assert_eq!(stream.status(), 200);
    host_gone(&s, Duration::from_secs(15)).await;
    assert_eq!(profiles(&s), 0);
    drop(stream);
    s.finish().await
}

#[tokio::test]
async fn without_a_usable_electron_the_headless_browser_serves() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    butler_e2e::skip_unless!(
        hidden_app(),
        "BUTLER_E2E_BROWSER_BACKEND=hidden-app not set"
    );
    // An executable that is no Electron: it exits at once, never attaching.
    let not_electron = butler_e2e::e2e::binary::mcp_fixture_binary()?;
    let s = setup("BROWSER-HIDDEN-FALLBACK")?
        .env(
            "BUTLER_BROWSER_APP",
            not_electron.to_string_lossy().into_owned(),
        )
        .start()
        .await?;
    let admin = admin(&s);
    let url = publish(&s).await?;
    let opened = call(
        &admin,
        "general",
        "tab.open",
        &Value::Null,
        json!({"url":url}),
    )
    .await?;
    // The headless browser took the call: its pinned download (from nowhere
    // in this scenario) is what stands in the way, not the App.
    assert_eq!(opened["status"], "unavailable", "{opened}");
    assert_eq!(opened["reason"], "browser_download_failed", "{opened}");
    assert_eq!(profiles(&s), 0, "the failed host left no profile");
    s.finish().await
}

#[tokio::test]
async fn hidden_outbox_backlog_blocks_retirement_until_drained() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    butler_e2e::skip_unless!(
        hidden_app(),
        "BUTLER_E2E_BROWSER_BACKEND=hidden-app not set"
    );
    let s = setup("BROWSER-HIDDEN-OUTBOX")?
        .env("BUTLER_BROWSER_HEADLESS", "off")
        .start()
        .await?;
    let admin = admin(&s);
    let url = publish(&s).await?;
    let opened = open(&admin, "general", &url).await?;
    assert_eq!(opened["status"], "ok");
    assert_eq!(
        call(&admin, "general", "tab.observe", &opened["tab"], json!({})).await?["status"],
        "ok"
    );
    // No tabs, calls or turn can keep this host busy: only its durable backlog.
    for count in [3, 0] {
        let response = admin
            .send(
                reqwest::Method::POST,
                "/internal/browser-host/events",
                Some(json!({"tabs":[],"still_backlog":count})),
                &[],
            )
            .await?;
        assert_eq!(response.status, 200);
        if count > 0 {
            let busy = attach_app(&admin).await?;
            assert_eq!(busy.status(), 409);
            assert!(busy.text().await?.contains("browser_host_busy"));
            assert_eq!(profiles(&s), 1, "backlog keeps the host alive");
        }
    }
    host_gone(&s, Duration::from_secs(15)).await;
    let stream = attach_app(&admin).await?;
    assert_eq!(stream.status(), 200, "drained host hands over");
    drop(stream);
    s.finish().await
}
