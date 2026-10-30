//! Shared setup for the headless-backend scenarios: the pinned browser in a
//! test-only cache, an output-hosted fixture site, and the internal calls.
#![allow(
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::panic,
    reason = "test assertions"
)]
use butler_e2e::e2e::{
    HarnessError,
    cassette::Cassette,
    scenario::{Access, Scenario, Setup},
    security::AdminClient,
};
use butler_platform::secure_fs::Canonical as _;
use reqwest::Method;
use serde_json::{Value, json};
use std::{path::PathBuf, time::Duration};

/// `BUTLER_E2E_BROWSER_BACKEND=headless` runs these scenarios on Chrome for
/// Testing (the first run downloads the pinned build into a temp cache);
/// `=hidden-app` runs them on the hidden App host: the in-worktree Electron
/// named by `BUTLER_E2E_ELECTRON` with the App's own executor, no Chrome.
pub(crate) fn selected() -> bool {
    matches!(backend().as_deref(), Ok("headless" | "hidden-app"))
}

fn backend() -> Result<String, std::env::VarError> {
    std::env::var("BUTLER_E2E_BROWSER_BACKEND")
}

/// Whether the scenarios run on the hidden App host (Electron).
pub(crate) fn hidden_app() -> bool {
    backend().as_deref() == Ok("hidden-app")
}

/// The in-worktree Electron and the App directory it loads.
pub(crate) fn electron() -> (PathBuf, PathBuf) {
    let executable = std::env::var_os("BUTLER_E2E_ELECTRON")
        .map(PathBuf::from)
        .expect("BUTLER_E2E_ELECTRON names the in-worktree Electron executable");
    let app = butler_e2e::e2e::binary::workspace_root()
        .join("../../butler-app/client/electron")
        .canonical()
        .expect("the in-worktree App directory");
    (executable, app)
}

/// The (never created) Chrome cache of a hidden-app scenario: any Chrome
/// install attempt would create it.
pub(crate) fn no_chrome_cache(id: &str) -> PathBuf {
    std::env::temp_dir().join(format!("butler-e2e-no-chrome-{id}"))
}

/// Where the browser of the selected backend keeps its profiles.
pub(crate) fn state_root(data: &std::path::Path) -> PathBuf {
    data.join(if hidden_app() {
        "state/browser/app-host"
    } else {
        "state/browser/headless"
    })
}

/// A shared, test-only download cache (never the owner's data folder).
pub(crate) fn cache() -> PathBuf {
    std::env::var_os("BUTLER_E2E_BROWSER_CACHE").map_or_else(
        || std::env::temp_dir().join("butler-e2e-chrome-for-testing"),
        PathBuf::from,
    )
}

pub(crate) fn setup(id: &str) -> Result<Setup, HarnessError> {
    let setup = Setup::new(id)?
        .access(Access::FullAccess)
        .env("BUTLER_BROWSER_HEADLESS", "on")
        .stub_cassette(cassette()?);
    if !hidden_app() {
        return Ok(setup.env(
            "BUTLER_BROWSER_CACHE_DIR",
            cache().to_string_lossy().into_owned(),
        ));
    }
    // Agent launch clears inherited environment; Electron still needs the
    // selected display while its profile and home remain isolated.
    let setup = if let Ok(display) = std::env::var("DISPLAY") {
        setup.env("DISPLAY", display)
    } else {
        setup
    };
    let (executable, app) = electron();
    // Chrome can never come into it: no cache, and nowhere to download from.
    let cache = no_chrome_cache(id);
    Ok(setup
        .env(
            "BUTLER_BROWSER_APP",
            executable.to_string_lossy().into_owned(),
        )
        .env("BUTLER_BROWSER_APP_DIR", app.to_string_lossy().into_owned())
        .env(
            "BUTLER_BROWSER_CACHE_DIR",
            cache.to_string_lossy().into_owned(),
        )
        .env("BUTLER_BROWSER_DOWNLOAD_BASE", "http://127.0.0.1:9/"))
}

pub(crate) fn admin(s: &Scenario) -> AdminClient {
    AdminClient::new(s.gw.clone(), s.agent.launch.admin_credential().unwrap())
}

pub(crate) async fn call(
    admin: &AdminClient,
    session: &str,
    op: &str,
    tab: &Value,
    args: Value,
) -> Result<Value, HarnessError> {
    let reply = admin
        .send(
            Method::POST,
            "/internal/browser/calls",
            Some(json!({"op":op,"session":session,"tab":tab,"args":args})),
            &[],
        )
        .await?;
    assert_eq!(reply.status, 200, "{op}: {}", reply.text);
    Ok(reply.body)
}

/// `tab.open`, waiting out the first-use install.
pub(crate) async fn open(
    admin: &AdminClient,
    session: &str,
    url: &str,
) -> Result<Value, HarnessError> {
    // The first use downloads ~100 MB; polls every 2 s for up to 15 minutes.
    for _ in 0..450 {
        let opened = call(admin, session, "tab.open", &Value::Null, json!({"url":url})).await?;
        if opened["reason"] != "browser_installing" {
            return Ok(opened);
        }
        tokio::time::sleep(Duration::from_secs(2)).await;
    }
    panic!("the pinned browser install did not finish");
}

pub(crate) fn node<'a>(observation: &'a Value, role: &str, name: &str) -> &'a Value {
    observation["nodes"]
        .as_array()
        .unwrap()
        .iter()
        .find(|n| n["role"] == role && n["name"] == name)
        .unwrap_or_else(|| panic!("{role} {name:?} in {}", observation["text"]))
}

/// A screenshot point at the center of an observed node.
pub(crate) fn center(observation: &Value, node: &Value) -> Value {
    let g = &observation["image_geometry"];
    let (sx, sy) = (
        g["width"].as_f64().unwrap() / g["cssWidth"].as_f64().unwrap(),
        g["height"].as_f64().unwrap() / g["cssHeight"].as_f64().unwrap(),
    );
    let r = &node["rect"];
    let x = (r["x"].as_f64().unwrap() + r["width"].as_f64().unwrap() / 2.0) * sx;
    let y = (r["y"].as_f64().unwrap() + r["height"].as_f64().unwrap() / 2.0) * sy;
    json!([x.round(), y.round()])
}

/// Runs the "Publish fixture" turn and returns the output's content URL.
pub(crate) async fn publish(s: &Scenario) -> Result<String, HarnessError> {
    Ok(publish_as(s, "Publish fixture").await?.1)
}

/// Runs a publishing turn; returns the output id and its content URL.
pub(crate) async fn publish_as(
    s: &Scenario,
    prompt: &str,
) -> Result<(String, String), HarnessError> {
    publish_in(s, "general", prompt).await
}
pub(crate) async fn publish_in(
    s: &Scenario,
    session: &str,
    prompt: &str,
) -> Result<(String, String), HarnessError> {
    let port = reqwest::Url::parse(&s.gw.base).unwrap().port().unwrap();
    s.provider()?
        .add_placeholder("GATEWAY_PORT", port.to_string());
    let (turn, _) = s.turn(session, prompt).await?;
    let db = butler_platform::sqlite::open_with_flags(
        s.sandbox.data.join("agent-runtime/btcc.sqlite"),
        rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY,
    )
    .unwrap();
    let raw: String = db
        .query_row("SELECT result_json FROM btcc_guided_tool_calls WHERE tool_name='output_publish' AND turn_id=?1", [&turn], |r| r.get(0))
        .unwrap();
    let published: Value = serde_json::from_str(&raw).unwrap();
    let id = published["output_id"]
        .as_str()
        .unwrap_or_else(|| panic!("{published}"))
        .to_owned();
    let view = s.gw.get(&format!("/outputs/{id}/view")).await?;
    assert_eq!(view.status, 200, "{}", view.text);
    Ok((id, view.data()["url"].as_str().unwrap().to_owned()))
}

/// The selected browser's processes whose command line names `marker`
/// (`chrome-headless-shell`, or the Electron of the hidden App host).
pub(crate) fn browser_processes(marker: &str) -> Vec<String> {
    let executable = if hidden_app() {
        // Its helpers (`Electron Helper …`) name the profile as user data dir.
        let main = electron().0;
        main.file_stem().unwrap().to_string_lossy().into_owned()
    } else {
        "chrome-headless-shell".to_owned()
    };
    butler_platform::browser_process::matching_processes(&executable, marker)
        .expect("the scenario's browser process listing is readable")
}

/// The fixture's downloadable file.
pub(crate) const REPORT: &str = "quarter,total\nQ3,42\n";

/// An output with a script error, a wide block and a root-absolute image.
const BROKEN: &str = r#"<!doctype html><meta charset="utf-8"><title>Broken fixture</title>
<body style="margin:0"><h1>Broken page</h1><div style="width:1600px;height:40px;background:#c33"></div>
<img src="/missing.png" alt=""><script>console.error("fixture failed to start")</script></body>"#;

const INDEX: &str = r#"<!doctype html><meta charset="utf-8"><title>Headless fixture</title>
<style>body{font:18px system-ui;padding:24px;margin:0}button,input,a{font:inherit;margin:8px;padding:8px 16px}p{margin:8px}</style>
<main><h1>Headless browser</h1>
<button id="confirm" onclick="document.querySelector('#result').textContent='Confirmed'">Confirm</button><p id="result">Ready</p>
<input id="q" aria-label="Search" placeholder="Search">
<button id="submit" onclick="document.querySelector('#typed').textContent='Typed '+document.querySelector('#q').value">Submit</button><p id="typed">Typed nothing</p>
<button id="ask" onclick="document.querySelector('#answer').textContent=confirm('Proceed?')?'Accepted':'Declined'">Ask</button><p id="answer">No answer</p>
<button id="popup" onclick="window.open('./popup.html','_blank')">Open popup</button>
<p><a id="rebind" href="http://localhost.:{{GATEWAY_PORT}}/health">Loopback by name</a></p>
<p><a id="private" href="http://10.0.0.1/">Private address</a></p><!-- privacy-hygiene: allow-private-ip (LAN-denial fixture) -->
<p><a id="local" href="file:///etc/hosts">Local file</a></p>
<p><a id="report" href="./report.csv" download="report.csv">Download report</a></p>
</main>"#;
const POPUP: &str = r#"<!doctype html><meta charset="utf-8"><title>Popup fixture</title><main><h1>Popup page</h1><button onclick="document.title='Pressed'">Popup button</button></main>"#;

fn turn_calls(prompt: &str) -> Vec<(&'static str, Value)> {
    let describe = (
        "tool_describe",
        json!({"ids":["native:browser_open","native:browser_observe","native:browser_act"]}),
    );
    let tool = |id: &str, args: Value| {
        (
            "tool_call",
            json!({"id":format!("native:{id}"),"arguments":args}),
        )
    };
    match prompt {
        "Publish images" => vec![
            (
                "write_file",
                json!({"path":"image-assets/index.html","content":super::assets::page(),"create_parents":true}),
            ),
            (
                "write_file",
                json!({"path":"image-assets/not-image.txt","content":"This is text, not image pixels.","create_parents":true}),
            ),
            (
                "output_publish",
                json!({"path":"image-assets","entry":"index.html","title":"Image fixture"}),
            ),
        ],
        "Publish identity" => vec![
            (
                "write_file",
                json!({"path":"identity-site/index.html","content":super::identity::PAGE,"create_parents":true}),
            ),
            (
                "output_publish",
                json!({"path":"identity-site","title":"Identity fixture"}),
            ),
        ],
        "Publish devtools" => vec![
            (
                "write_file",
                json!({"path":"devtools-site/index.html","content":super::devtools::PAGE,"create_parents":true}),
            ),
            (
                "output_publish",
                json!({"path":"devtools-site","title":"DevTools fixture"}),
            ),
        ],
        "Publish devtools long" => vec![
            (
                "write_file",
                json!({"path":"devtools-long/index.html","content":super::devtools::LONG_PAGE,"create_parents":true}),
            ),
            (
                "output_publish",
                json!({"path":"devtools-long","title":"Long DevTools fixture"}),
            ),
        ],
        "Publish broken" => vec![
            (
                "write_file",
                json!({"path":"broken-site/index.html","content":BROKEN,"create_parents":true}),
            ),
            (
                "output_publish",
                json!({"path":"broken-site","title":"Broken fixture"}),
            ),
        ],
        "Publish fixture" => vec![
            (
                "write_file",
                json!({"path":"headless-site/index.html","content":INDEX,"create_parents":true}),
            ),
            (
                "write_file",
                json!({"path":"headless-site/popup.html","content":POPUP,"create_parents":true}),
            ),
            (
                "write_file",
                json!({"path":"headless-site/report.csv","content":REPORT,"create_parents":true}),
            ),
            (
                "output_publish",
                json!({"path":"headless-site","title":"Headless fixture"}),
            ),
        ],
        "Publish parallel" => super::parallel::publish_calls(),
        "Publish shop" => vec![
            (
                "write_file",
                json!({"path":"shop-site/index.html","content":super::speed::SHOP,"create_parents":true}),
            ),
            (
                "output_publish",
                json!({"path":"shop-site","title":"Shop fixture"}),
            ),
        ],
        "Open fixture" => vec![
            describe,
            tool("browser_open", json!({"url":"{{OUTPUT_URL}}"})),
        ],
        "Observe fixture" => vec![describe, tool("browser_observe", json!({"tab":"{{TAB}}"}))],
        _ => vec![
            describe,
            tool(
                "browser_act",
                json!({"tab":"{{TAB}}","observation":"{{OBS}}","observe":true,"steps":[{"action":"click","ref":"{{REF}}"}]}),
            ),
        ],
    }
}

fn cassette() -> Result<Cassette, HarnessError> {
    let template = Cassette::load("TOOL-01")?;
    let mut cassette = Cassette::load("TOOL-01")?;
    cassette.exchanges.clear();
    for history in 0..=6 {
        for prompt in [
            "Publish images",
            "Publish identity",
            "Publish broken",
            "Publish devtools",
            "Publish devtools long",
            "Publish fixture",
            "Publish shop",
            "Publish parallel",
            "Open fixture",
            "Observe fixture",
            "Act fixture",
        ] {
            let mut round = vec!["user".to_owned(); history];
            for (index, (name, args)) in turn_calls(prompt).into_iter().enumerate() {
                let mut exchange = template.exchanges[0].clone();
                exchange.request.key.user_request = prompt.into();
                exchange.request.key.round = round.clone();
                exchange.response = crate::browser_usage::stub::response(
                    &json!({"type":"function_call","id":format!("fc_headless_{index}"),"call_id":format!("call_headless_{index}"),"name":name,"arguments":args.to_string(),"status":"completed"}),
                );
                cassette.exchanges.push(exchange);
                round.extend(["function_call".into(), "function_call_output".into()]);
            }
            let mut last = template.exchanges[1].clone();
            last.request.key.user_request = prompt.into();
            last.request.key.round = round;
            last.response = crate::browser_usage::stub::response(
                &json!({"type":"message","id":"msg_headless","role":"assistant","status":"completed","content":[{"type":"output_text","text":"Done.","annotations":[]}]}),
            );
            cassette.exchanges.push(last);
        }
    }
    Ok(cassette)
}

/// The newest function output of a provider request, decoded from its text part.
pub(crate) fn tool_output(request: &Value) -> Value {
    let item = request["input"]
        .as_array()
        .unwrap()
        .iter()
        .rev()
        .find(|item| item["type"] == "function_call_output")
        .unwrap();
    let text = item["output"].as_array().map_or_else(
        || item["output"].as_str().unwrap().to_owned(),
        |parts| {
            parts.iter().find(|p| p["type"] == "input_text").unwrap()["text"]
                .as_str()
                .unwrap()
                .to_owned()
        },
    );
    let mut value: Value = serde_json::from_str(&text).unwrap();
    if value.get("output").is_some() {
        return value["output"].take();
    }
    value
}
