//! Browsing speed in the page executor (headless or hidden App): a tab returns
//! at its parsed document and the next observation waits out the load, a
//! page's endless motion does not hold the settle open, and a batch that keeps
//! moving between views already seen is named and then refused.
#![allow(
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::panic,
    reason = "test assertions"
)]
use super::support::{admin, call, node, open, publish_as, selected, setup};
use super::text;
use butler_e2e::e2e::{HarnessError, security::AdminClient};
use serde_json::{Value, json};
use std::time::Instant;

/// A product page with a fixed header whose ticker never stops changing,
/// a cookie banner, the price one screen down, and load-time content.
pub(crate) const SHOP: &str = r#"<!doctype html><meta charset="utf-8"><title>Shop fixture</title>
<style>body{margin:0;font:16px system-ui}header{position:fixed;top:0;left:0;right:0;height:96px;background:#111;color:#fff;z-index:5}
.ticker{margin:0;padding:8px}.ticker li{display:inline-block;margin-right:16px}.ticker li.on{color:#fc0}
main{padding:120px 24px 24px}section{min-height:760px}#consent{position:fixed;bottom:0;left:0;right:0;padding:16px;background:#eee;color:#111;z-index:6}</style>
<header><ul class="ticker"><li>New in</li><li>Outer sale</li><li>Free delivery</li></ul></header>
<div id="consent"><p>We use cookies</p><button onclick="this.parentNode.remove()">Accept</button></div>
<main><h1>Field jacket</h1><section><p>Cotton field jacket</p><p id="state">Loading</p></section>
<section><p>Price 89,000 won</p></section><section><p>Reviews 12</p></section></main>
<script>const items=[...document.querySelectorAll('.ticker li')];let n=0;
setInterval(()=>{items.forEach(e=>e.classList.toggle('on',e===items[n%items.length]));n++},40);
addEventListener('load',()=>{document.querySelector('#state').textContent='Loaded'})</script>"#;

/// The fixture conversation (a step keeps its still in that chat).
const ME: &str = "general";

#[tokio::test]
async fn headless_speed_parsed_open_motion_settle_and_view_loops() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    butler_e2e::skip_unless!(selected(), "BUTLER_E2E_BROWSER_BACKEND=headless not set");
    let s = setup("BROWSER-HEADLESS-SPEED")?.start().await?;
    let admin = admin(&s);
    let url = publish_as(&s, "Publish shop").await?.1;
    let warm = open(&admin, "warmup", &url).await?;
    call(&admin, "warmup", "tab.close", &warm["tab"], json!({})).await?;
    let started = Instant::now();
    let opened = open(&admin, ME, &url).await?;
    let open_ms = started.elapsed().as_millis();
    assert_eq!(opened["status"], "ok", "{opened}");
    let tab = opened["tab"].clone();
    let started = Instant::now();
    let first = call(
        &admin,
        ME,
        "tab.observe",
        &tab,
        json!({"include_image":true}),
    )
    .await?;
    let observe_ms = started.elapsed().as_millis();
    assert!(
        text(&first).contains("Loaded"),
        "the observation waits for the load: {}",
        text(&first)
    );
    let accept = json!([{"action":"click","ref":node(&first, "button", "Accept")["ref"]}]);
    let (accepted, accept_ms) = step(&admin, &tab, &first, &accept).await?;
    assert!(
        !text(&accepted).contains("We use cookies"),
        "the newest state: {}",
        text(&accepted)
    );
    let mut current = accepted;
    let (mut notes, mut step_ms) = (Vec::new(), Vec::new());
    for key in ["PageDown", "Home", "PageDown", "Home"] {
        let (next, ms) = step(
            &admin,
            &tab,
            &current,
            &json!([{"action":"press","value":key}]),
        )
        .await?;
        notes.push(next["progress"]["notes"].to_string());
        step_ms.push(ms);
        current = next;
    }
    eprintln!(
        "headless-speed open_ms={open_ms} observe_ms={observe_ms} accept_settled_ms={accept_ms} key_settled_ms={step_ms:?}"
    );
    assert!(notes[0] == "null", "a new view: {}", notes[0]);
    for note in &notes[1..] {
        assert!(note.contains("back to the view it showed at"), "{note}");
    }
    assert!(text(&current).contains("Field jacket") && !text(&current).contains("Price 89,000"));
    let again = json!([{"action":"press","value":"PageDown"}]);
    let refused = call(
        &admin,
        ME,
        "tab.prepare",
        &tab,
        json!({"observation":current["obs"],"steps":again}),
    )
    .await?;
    assert_eq!(refused["reason"], "repeated_no_progress", "{refused}");
    // Another control from the same view still runs.
    let other = json!([{"action":"press","value":"ArrowDown"}]);
    step(&admin, &tab, &current, &other).await?;
    s.finish().await
}

/// One prepared batch and its settled observation, as `observe: true` runs it.
async fn step(
    admin: &AdminClient,
    tab: &Value,
    from: &Value,
    steps: &Value,
) -> Result<(Value, u128), HarnessError> {
    let started = Instant::now();
    let prepared = call(
        admin,
        ME,
        "tab.prepare",
        tab,
        json!({"observation":from["obs"],"steps":steps}),
    )
    .await?;
    assert_eq!(prepared["status"], "ok", "{prepared}");
    let acted = call(
        admin,
        ME,
        "tab.act",
        tab,
        json!({"observation":from["obs"],"steps":steps,"prepared_steps":prepared["steps"]}),
    )
    .await?;
    assert_eq!(acted["steps"][0]["status"], "completed", "{acted}");
    let observed = call(
        admin,
        ME,
        "tab.observe",
        tab,
        json!({"include_image":true,"settle":true}),
    )
    .await?;
    assert_eq!(observed["status"], "ok", "{observed}");
    Ok((observed, started.elapsed().as_millis()))
}
