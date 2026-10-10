//! Guard denials and the idle reap of the headless browser.
#![allow(
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::panic,
    reason = "test assertions"
)]
use super::{
    backend,
    support::{admin, browser_processes, call, node, open},
};
use butler_e2e::e2e::HarnessError;
use serde_json::{Value, json};
use std::time::Duration;

pub(super) async fn guard_denials(
    admin: &butler_e2e::e2e::security::AdminClient,
    s: &butler_e2e::e2e::scenario::Scenario,
    tab: &Value,
    url: &str,
) -> Result<(), HarnessError> {
    let me = "general";
    // No signed-in headless: the profile is in-memory and signed-out only.
    let signed = call(
        admin,
        me,
        "tab.open",
        &Value::Null,
        json!({"url":url,"signed_in":true}),
    )
    .await?;
    assert_eq!(signed["reason"], "signed_in_unavailable", "{signed}");
    // Another conversation never reaches this tab.
    let foreign = call(admin, "other", "tab.observe", tab, json!({})).await?;
    assert_eq!(foreign["reason"], "not_your_tab", "{foreign}");
    // file:, loopback and private destinations are refused before opening.
    for denied in [
        "file:///etc/hosts",
        "http://127.0.0.1:9/",
        "http://169.254.169.254/",
        "http://10.0.0.1/",
    ] {
        let reply = admin
            .send(
                reqwest::Method::POST,
                "/internal/browser/calls",
                Some(json!({"op":"tab.open","session":me,"args":{"url":denied}})),
                &[],
            )
            .await?;
        assert_eq!(reply.status, 400, "{denied}: {}", reply.text);
    }
    // A page link to file: never navigates.
    let page = call(admin, me, "tab.observe", tab, json!({"include_image":true})).await?;
    let local = node(&page, "link", "Local file")["ref"].clone();
    let steps = json!([{"action":"click","ref":local}]);
    let prepared = call(
        admin,
        me,
        "tab.prepare",
        tab,
        json!({"observation":page["obs"],"steps":steps}),
    )
    .await?;
    call(
        admin,
        me,
        "tab.act",
        tab,
        json!({"observation":page["obs"],"steps":steps,"prepared_steps":prepared["steps"]}),
    )
    .await?;
    let still = call(admin, me, "tab.observe", tab, json!({"settle":true})).await?;
    assert_eq!(still["url"], url, "{still}");
    // A name that resolves to loopback (DNS rebinding's shape) closes the tab.
    let rebind = node(&still, "link", "Loopback by name")["ref"].clone();
    let steps = json!([{"action":"click","ref":rebind}]);
    let prepared = call(
        admin,
        me,
        "tab.prepare",
        tab,
        json!({"observation":still["obs"],"steps":steps}),
    )
    .await?;
    call(
        admin,
        me,
        "tab.act",
        tab,
        json!({"observation":still["obs"],"steps":steps,"prepared_steps":prepared["steps"]}),
    )
    .await?;
    let mut gone = Value::Null;
    for _ in 0..50 {
        gone = call(admin, me, "tab.observe", tab, json!({})).await?;
        if gone["reason"] == "not_your_tab" {
            break;
        }
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
    assert_eq!(
        gone["reason"], "not_your_tab",
        "a guarded navigation closes the tab: {gone}"
    );
    // The private-address link does the same on a fresh tab.
    let fresh = open(admin, me, url).await?;
    let page = call(
        admin,
        me,
        "tab.observe",
        &fresh["tab"],
        json!({"include_image":true}),
    )
    .await?;
    let private = node(&page, "link", "Private address")["ref"].clone();
    let steps = json!([{"action":"click","ref":private}]);
    let prepared = call(
        admin,
        me,
        "tab.prepare",
        &fresh["tab"],
        json!({"observation":page["obs"],"steps":steps}),
    )
    .await?;
    call(
        admin,
        me,
        "tab.act",
        &fresh["tab"],
        json!({"observation":page["obs"],"steps":steps,"prepared_steps":prepared["steps"]}),
    )
    .await?;
    for _ in 0..50 {
        gone = call(admin, me, "tab.observe", &fresh["tab"], json!({})).await?;
        if gone["reason"] == "not_your_tab" {
            break;
        }
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
    assert_eq!(gone["reason"], "not_your_tab", "{gone}");
    let _ = s;
    Ok(())
}

/// No browser process and no writes once the last tab is 60 s gone.
pub(super) async fn idle_reap(s: &butler_e2e::e2e::scenario::Scenario) -> Result<(), HarnessError> {
    let admin = admin(s);
    let listed = call(&admin, "general", "tabs.list", &Value::Null, json!({})).await?;
    for tab in listed["tabs"].as_array().unwrap() {
        call(&admin, "general", "tab.close", &tab["id"], json!({})).await?;
    }
    let marker = s.sandbox.data.to_string_lossy().into_owned();
    assert!(
        !browser_processes(&marker).is_empty(),
        "the browser runs until the reap"
    );
    // Polled once a second: the tree lives through the 60 s grace, then ends.
    let mut seconds = 0;
    while !browser_processes(&marker).is_empty() {
        seconds += 1;
        assert!(seconds <= 90, "{:?}", browser_processes(&marker));
        tokio::time::sleep(Duration::from_secs(1)).await;
    }
    assert!(
        seconds >= 50,
        "reaped after {seconds} polls, before the 60 s grace"
    );
    let root = s.sandbox.data.join("state/browser/headless");
    let profiles = std::fs::read_dir(&root)?
        .flatten()
        .filter(|e| e.file_name().to_string_lossy().starts_with("profile-"))
        .count();
    assert_eq!(profiles, 0, "the throwaway profile is removed");
    let before = backend::tree(&s.sandbox.data);
    tokio::time::sleep(Duration::from_secs(10)).await;
    assert_eq!(
        backend::tree(&s.sandbox.data),
        before,
        "no writes while idle"
    );
    Ok(())
}
