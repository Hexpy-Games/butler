//! Registered dev-server previews on the headless browser: the preview's
//! root mount and its HMR socket load, other loopback stays denied, and
//! stopping the preview closes its tab.
#![allow(
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::panic,
    reason = "test assertions"
)]
use super::support::{admin, call, open, publish, selected, setup};
use butler_e2e::e2e::HarnessError;
use serde_json::{Value, json};
use std::time::Duration;

/// A dev server: a page, an image, and an HMR socket that says "ready".
const SERVER: &str = r#"
const port=Number(process.argv[2]);
const png=Uint8Array.from(atob("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=="),c=>c.charCodeAt(0));
Bun.serve({hostname:"127.0.0.1",port,fetch(request,server){
 const path=new URL(request.url).pathname;
 if(path==="/hmr"&&server.upgrade(request))return;
 if(path==="/pixel.png")return new Response(png,{headers:{"content-type":"image/png"}});
 return new Response(`<!doctype html><title>Dev preview</title><h1>Dev server</h1>
<p id=mount>Mounted pending</p><p id=direct>Direct pending</p><p id=hmr>HMR pending</p>
<img alt="" src="/pixel.png" onload="mount.textContent='Mounted loaded'" onerror="mount.textContent='Mounted failed'">
<img alt="" src="http://127.0.0.1:${port}/pixel.png" onload="direct.textContent='Direct loaded'" onerror="direct.textContent='Direct blocked'">
<script>const ws=new WebSocket("ws://"+location.host+"/hmr");ws.onmessage=e=>hmr.textContent="HMR "+e.data;ws.onerror=()=>hmr.textContent="HMR failed";</script>`,{headers:{"content-type":"text/html"}});
},websocket:{open(ws){ws.send("ready")},message(){}}});
"#;

fn port() -> u16 {
    std::net::TcpListener::bind("127.0.0.1:0")
        .unwrap()
        .local_addr()
        .unwrap()
        .port()
}

#[tokio::test]
async fn headless_opens_registered_previews_only() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    butler_e2e::skip_unless!(selected(), "BUTLER_E2E_BROWSER_BACKEND=headless not set");
    // The fixture uses the runner's existing Bun; HOME and data stay isolated.
    let setup = setup("BROWSER-HEADLESS-PREVIEW")?.env(
        "PATH",
        std::env::var("PATH").expect("runner PATH is required"),
    );
    let cwd = setup.sandbox.workspace.clone();
    std::fs::write(cwd.join("server.mjs"), SERVER)?;
    let s = setup.start().await?;
    let admin = admin(&s);
    // Install the pinned browser first, so the preview's tab opens at once.
    let url = publish(&s).await?;
    let warm = open(&admin, "warmup", &url).await?;
    assert_eq!(warm["status"], "ok", "{warm}");
    call(&admin, "warmup", "tab.close", &warm["tab"], json!({})).await?;

    let dev = port();
    let args = json!({"agent":"preview-agent","preview_id":"preview-headless",
        "command":format!("bun server.mjs {dev}"),"cwd":cwd,"port":dev});
    let started = call(&admin, "general", "preview.start", &Value::Null, args).await?;
    assert_eq!(started["status"], "ok", "{started}");
    assert_eq!(started["browser"]["status"], "ok", "{started}");
    let tab = started["browser"]["tab"].clone();
    let mut text = String::new();
    for _ in 0..50 {
        let seen = call(
            &admin,
            "general",
            "tab.observe",
            &tab,
            json!({"settle":true}),
        )
        .await?;
        text = seen["text"].as_str().unwrap_or("").to_owned();
        if !text.contains("pending") {
            break;
        }
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
    for expected in [
        "Dev server",
        "Mounted loaded",
        "Direct blocked",
        "HMR ready",
    ] {
        assert!(text.contains(expected), "{expected}: {text}");
    }
    let listed = call(&admin, "general", "tabs.list", &Value::Null, json!({})).await?;
    assert_eq!(listed["tabs"][0]["preview"], "preview-headless", "{listed}");

    // Another conversation cannot open this preview.
    let foreign = admin
        .send(
            reqwest::Method::POST,
            "/internal/browser/calls",
            Some(json!({"op":"tab.open","session":"other","args":{"url":started["url"]}})),
            &[],
        )
        .await?;
    assert_eq!(foreign.status, 400, "{}", foreign.text);

    // Stopping the preview closes its tab and retires its URL.
    let stopped = call(
        &admin,
        "general",
        "preview.stop",
        &Value::Null,
        json!({"agent":"preview-agent","preview_id":"preview-headless"}),
    )
    .await?;
    assert_eq!(stopped["status"], "ok", "{stopped}");
    let gone = call(&admin, "general", "tab.observe", &tab, json!({})).await?;
    assert_eq!(gone["reason"], "not_your_tab", "{gone}");
    let retired = admin
        .send(
            reqwest::Method::POST,
            "/internal/browser/calls",
            Some(json!({"op":"tab.open","session":"general","args":{"url":started["url"]}})),
            &[],
        )
        .await?;
    assert_eq!(retired.status, 400, "{}", retired.text);
    s.finish().await
}
