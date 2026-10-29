//! Real delegated tool execution must use the public parent's browser lease.
#![allow(
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::panic,
    reason = "test assertions"
)]
pub(super) mod answer;
use super::steward_presentation::stub;
use base64::{Engine, engine::general_purpose::STANDARD};
use butler_e2e::e2e::{HarnessError, cassette::Cassette, scenario::Setup, security::AdminClient};
use reqwest::{Method, Response};
use serde_json::{Value, json};
use std::{sync::atomic::Ordering, time::Duration};

#[tokio::test]
async fn delegated_browser_tools_use_public_parent_ownership() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    let (url, script, server) = stub::start().await?;
    script.browser.store(true, Ordering::SeqCst);
    let s = Setup::new("BROWSER-DELEGATION")?
        .stub_cassette(Cassette::load("TOOL-01")?)
        .env("BUTLER_CHATGPT_API_BASE_URL", format!("{url}/v1"))
        .start()
        .await?;
    let admin = AdminClient::new(s.gw.clone(), s.agent.launch.admin_credential().unwrap());
    let stream = reqwest::Client::new()
        .get(format!("{}/internal/browser-host", s.gw.base))
        .bearer_auth(&s.gw.token)
        .header("x-butler-admin", &admin.admin)
        .send()
        .await?;
    assert_eq!(stream.status(), 200);
    let host = tokio::spawn(serve_host(stream, admin, false, "general".to_owned()));
    s.turn("general", stub::OWNER).await?;
    tokio::time::timeout(Duration::from_secs(30), host)
        .await
        .unwrap()
        .unwrap()?;
    let view = s.gw.get("/session-view?session_id=general").await?;
    let child = view.data()["steward_children"][0]["session_id"]
        .as_str()
        .unwrap()
        .to_owned();
    assert_ne!(child, "");
    assert_ne!(child, "general");
    tokio::time::timeout(Duration::from_secs(10), async {
        while !script
            .requests
            .lock()
            .unwrap()
            .iter()
            .any(|request| request.to_string().contains("safePathLabel"))
        {
            tokio::time::sleep(Duration::from_millis(100)).await;
        }
    })
    .await
    .unwrap();
    assert!(
        script
            .requests
            .lock()
            .unwrap()
            .iter()
            .any(|request| request.to_string().contains("image_assets:")
                && request.to_string().contains("img_")),
        "parent must receive collected ids"
    );
    assert!(
        script.requests.lock().unwrap().iter().any(|request| request
            .to_string()
            .contains("attached to your reply automatically")),
        "the parent model receives the canonical capture path, not only an evidence id"
    );
    assert!(
        script
            .requests
            .lock()
            .unwrap()
            .iter()
            .any(|request| request.to_string().contains("input_image"))
    );
    assert!(
        script.requests.lock().unwrap().iter().any(|request| request
            .to_string()
            .contains("Another element covers this image. Do not retry the same source.")),
        "a refused collection names another source instead of a retry"
    );
    assert!(
        !script
            .requests
            .lock()
            .unwrap()
            .iter()
            .any(|request| request.to_string().contains("Butler's Plan presents")),
        "a Plan without a presentation decision asks the steward for no blocks"
    );
    {
        let requests = script.requests.lock().unwrap();
        for recovery in [
            "Retry with the exact bound work_id:",
            "Use the exact bound work_id:",
        ] {
            assert!(
                requests
                    .iter()
                    .any(|request| request.to_string().contains(recovery)),
                "a wrong Work identifier returns its exact bound recovery target"
            );
        }
    }
    let navigation = s.gw.get("/navigation").await?;
    assert!(
        !navigation.text.contains(&child),
        "internal child in sidebar"
    );
    let db = rusqlite::Connection::open(s.sandbox.data.join("agent-runtime/btcc.sqlite")).unwrap();
    let session: String = db.query_row(
        "SELECT t.session_id FROM btcc_guided_tool_calls c JOIN btcc_turns t ON t.turn_id=c.turn_id WHERE c.tool_name='browser_open'",
        [], |row| row.get(0)).unwrap();
    assert_eq!(session, child, "tool really ran in the internal child");
    let raw: String = db
        .query_row(
            "SELECT result_json FROM btcc_guided_tool_calls WHERE tool_name='image_collect' ORDER BY rowid LIMIT 1",
            [],
            |r| r.get(0),
        )
        .unwrap();
    let asset: Value = serde_json::from_str(&raw).unwrap();
    assert!(asset["id"].as_str().unwrap().starts_with("img_"));
    assert!(
        asset.get("signed_url").is_none(),
        "HTTP signatures stay out of model results"
    );
    drop(db);
    s.finish().await?;
    server.abort();
    Ok(())
}

async fn serve_host(
    mut stream: Response,
    admin: AdminClient,
    answer: bool,
    session: String,
) -> Result<(), HarnessError> {
    let mut buffer = String::new();
    let mut ops = vec![
        "tab.open",
        "tabs.list",
        "tab.observe",
        "tab.screenshot",
        "tab.image_collect",
        "tab.image_collect",
    ];
    if answer {
        ops.extend(["tab.open", "tab.observe", "tab.screenshot"]);
    }
    let mut tabs = Vec::new();
    for op in ops {
        let frame = next_call(&mut stream, &mut buffer, op, &session).await?;
        assert_eq!(
            frame["session"], session,
            "internal session reached browser host: {frame}"
        );
        let url = if op == "tab.open" {
            frame["args"]["url"]
                .as_str()
                .unwrap_or("https://example.com/")
                .to_owned()
        } else {
            tabs.iter()
                .find(|tab: &&Value| tab["id"] == frame["args"]["tab"])
                .and_then(|tab| tab["url"].as_str())
                .unwrap_or("https://example.com/")
                .to_owned()
        };
        let tab_id = if url.starts_with("https://example.org/") {
            "other-tab"
        } else {
            "parent-tab"
        };
        let tab = json!({"id":tab_id,"owner":format!("conversation:{session}"),"profile":"signed_out","epoch":1,"holder":"agent","url":url});
        if op == "tab.open" {
            tabs.push(tab.clone());
            let event = admin
                .send(
                    Method::POST,
                    "/internal/browser-host/events",
                    Some(json!({"tabs":tabs.clone()})),
                    &[],
                )
                .await?;
            assert_eq!(event.status, 200);
        }
        let result = match op {
            "tabs.list" => json!({"tabs":tabs.clone()}),
            "tab.observe" => json!({"status":"ok","tab":tab_id,
                "obs":if tab_id == "other-tab" {"other-observation"} else {"parent-observation"},
                "url":url,"text":if tab_id == "other-tab" {"Other page"} else {"Parent page"},
                "image":{"mime_type":"image/jpeg","data":STANDARD.encode(include_bytes!("browser_outputs/pixel.jpg"))}}),
            "tab.image_collect" if !answer && frame["args"]["ref"] == "image-ref-8" => {
                json!({"status":"refused","reason":"blocked_by"})
            }
            "tab.image_collect" => {
                json!({"status":"ok","pixel_ratio":2,"source_url":"https://example.com/image.jpg","alt":"Collected raster","nearby_text":"Context","image":{"data":STANDARD.encode(if answer && frame["args"]["ref"] == "image-ref-8" { include_bytes!("browser_outputs/second.jpg").as_slice() } else { include_bytes!("browser_outputs/pixel.jpg").as_slice() })}})
            }
            "tab.screenshot" => json!({"status":"ok","tab":tab_id,"url":url,
                "image":{"mime_type":"image/jpeg","data":STANDARD.encode(include_bytes!("browser_outputs/pixel.jpg"))}}),
            _ => json!({"status":"ok","tab":tab_id,"url":url}),
        };
        assert!(!result.to_string().contains("steward"));
        let reply = admin
            .send(
                Method::POST,
                &format!(
                    "/internal/browser-host/results/{}",
                    frame["id"].as_str().unwrap()
                ),
                Some(result),
                &[],
            )
            .await?;
        assert_eq!(reply.status, 200);
        if op != "tabs.list" {
            let ended = next_frame(&mut stream, &mut buffer).await?;
            assert_eq!(ended["op"], "use.ended");
            assert_eq!(ended["session"], session);
            assert_eq!(ended["turn_id"], frame["turn_id"]);
            assert_eq!(ended["args"]["id"], frame["id"]);
            assert_eq!(ended["args"]["abort"], false);
        }
    }
    let finished = next_frame(&mut stream, &mut buffer).await?;
    assert_eq!(finished["op"], "use.finished");
    assert_eq!(finished["session"], session);
    assert_eq!(
        finished["args"]["close_read_tabs"], true,
        "a delegated turn's end closes the tabs it only read: {finished}"
    );
    assert!(
        finished["turn_id"]
            .as_str()
            .unwrap()
            .starts_with("steward-turn-")
    );
    Ok(())
}

async fn next_call(
    stream: &mut Response,
    buffer: &mut String,
    op: &str,
    session: &str,
) -> Result<Value, HarnessError> {
    let started = if op == "tabs.list" {
        None
    } else {
        let frame = next_frame(stream, buffer).await?;
        assert_eq!(frame["op"], "use.started");
        assert_eq!(frame["session"], session);
        Some(frame)
    };
    let frame = next_frame(stream, buffer).await?;
    assert_eq!(frame["op"], op);
    if let Some(started) = started {
        assert_eq!(started["id"], frame["id"]);
        assert_eq!(started["tab"], frame["tab"]);
        assert_eq!(started["turn_id"], frame["turn_id"]);
    }
    Ok(frame)
}

pub(super) async fn next_frame(
    stream: &mut Response,
    buffer: &mut String,
) -> Result<Value, HarnessError> {
    loop {
        if let Some(end) = buffer.find("\n\n") {
            let event = buffer[..end].to_owned();
            buffer.drain(..end + 2);
            if let Some(data) = event.lines().find_map(|line| line.strip_prefix("data: ")) {
                return Ok(serde_json::from_str(data)?);
            }
        } else {
            let chunk = stream.chunk().await?.expect("browser host frame");
            buffer.push_str(std::str::from_utf8(&chunk).unwrap());
        }
    }
}

/// The `include_image` an observation frame must carry: the model's `look`;
/// after a batch whose effect only pixels show (points, drags, a canvas hit)
/// a screenshot; otherwise `auto`, where the host decides from the page.
pub(super) fn expected_pixels(frame: &Value, last_act: Option<&(Value, Value)>) -> Value {
    let args = &frame["args"];
    match args["look"].as_str() {
        Some("always") => return json!(true),
        Some("never") => return json!(false),
        _ => {}
    }
    let visual = args["settle"] == true
        && last_act.is_some_and(|(act, result)| {
            let steps = act["steps"].as_array().into_iter().flatten();
            let canvas = result["steps"].as_array().into_iter().flatten();
            steps.into_iter().any(|step| {
                step.get("point").is_some()
                    || step.get("target_point").is_some()
                    || step["action"] == "drag"
            }) || canvas
                .into_iter()
                .any(|step| step["hit"]["role"] == "canvas")
        });
    if visual { json!(true) } else { json!("auto") }
}
