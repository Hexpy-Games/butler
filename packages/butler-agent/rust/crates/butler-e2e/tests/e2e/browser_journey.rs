//! Public user turn: discover, act, attach, finish. Native page effects have App smoke proof.
#![allow(
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::panic,
    reason = "test assertions"
)]
use base64::{Engine, engine::general_purpose::STANDARD};
use butler_e2e::e2e::{HarnessError, cassette::Cassette, scenario::Setup, security::AdminClient};
use reqwest::Method;
use serde_json::{Value, json};
use std::time::Duration;

#[tokio::test]
async fn user_browser_journey_projects_pixels_and_reply_crop_then_releases()
-> Result<(), HarnessError> {
    butler_e2e::gate!();
    let s = Setup::new("BROWSER-JOURNEY")?
        .stub_cassette(cassette()?)
        .start()
        .await?;
    let admin = AdminClient::new(s.gw.clone(), s.agent.launch.admin_credential().unwrap());
    let stream = reqwest::Client::new()
        .get(format!("{}/internal/browser-host", s.gw.base))
        .bearer_auth(&s.gw.token)
        .header("x-butler-admin", &admin.admin)
        .send()
        .await?;
    let host = tokio::spawn(serve_host(stream, admin));
    let (turn, _) = s.turn("general", "Browser journey").await?;
    tokio::time::timeout(Duration::from_secs(10), host)
        .await
        .unwrap()
        .unwrap()?;
    let view = s.gw.get("/session-view?session_id=general").await?;
    let messages = view.data()["messages"].as_array().unwrap().clone();
    let reply = messages
        .iter()
        .rev()
        .find(|m| m["role"] == "assistant")
        .unwrap();
    let attachments = reply["attachments"]
        .as_array()
        .expect("real final image attachment");
    assert_eq!(attachments.len(), 1);
    assert_eq!(attachments[0]["kind"], "image");
    assert_eq!(attachments[0]["mime_type"], "image/jpeg");
    assert_eq!(
        attachments[0]["size_bytes"],
        include_bytes!("browser_outputs/pixel.jpg").len()
    );
    let requests = s.provider()?.requests();
    assert!(
        requests[4]
            .to_string()
            .contains("Fill one autocomplete field"),
        "discovery must preserve the model-facing instructions, not just schemas"
    );
    for request in &requests[1..=2] {
        let result: Value = serde_json::from_str(
            request["input"]
                .as_array()
                .unwrap()
                .iter()
                .rev()
                .find(|item| item["type"] == "function_call_output")
                .unwrap()["output"]
                .as_str()
                .unwrap(),
        )
        .unwrap();
        assert!(
            result["output"]["results"].as_array().unwrap().is_empty(),
            "requested filters remain exact"
        );
        assert!(
            result["output"]["other_matches"]
                .as_array()
                .unwrap()
                .iter()
                .any(|tool| tool["id"] == "native:browser_observe" && tool["enabled"] == true)
        );
    }
    let last = requests.last().unwrap();
    assert!(
        last.to_string()
            .contains("operation_result_missing_or_scope_mismatch"),
        "a fabricated result ref is refused without aborting the user journey"
    );
    assert!(
        last.to_string().contains("image_unavailable"),
        "a missing capture is refused, never presented as a DOM-only success"
    );
    let input = last["input"].as_array().unwrap();
    let visual = input
        .iter()
        .filter(|item| {
            item["output"]
                .as_array()
                .is_some_and(|parts| parts.iter().any(|part| part["type"] == "input_image"))
        })
        .count();
    assert_eq!(
        visual, 2,
        "newest observation and actual reply capture retain pixels"
    );
    assert!(
        input
            .iter()
            .any(|item| item["output"].to_string().contains("superseded"))
    );
    assert!(
        input.iter().any(|item| item["output"]
            .as_array()
            .is_some_and(|parts| parts.iter().any(|p| p["type"] == "input_text"
                && p["text"]
                    .as_str()
                    .is_some_and(|text| text.contains("butler.browser-capture.v1"))))),
        "the actual captured crop must reach the model for visual review"
    );
    let latest: Value = input
        .iter()
        .filter_map(|item| item["output"].as_array())
        .filter(|parts| parts.iter().any(|part| part["type"] == "input_image"))
        .find_map(|parts| {
            let result: Value = serde_json::from_str(
                parts.iter().find(|p| p["type"] == "input_text")?["text"].as_str()?,
            )
            .ok()?;
            if result["output"]["schema"] != "butler.browser-observation.v1" {
                return None;
            }
            parts
                .iter()
                .find(|part| part["type"] == "input_text")
                .and_then(|part| serde_json::from_str(part["text"].as_str()?).ok())
        })
        .unwrap();
    for item in input {
        let Some(raw) = item["output"].as_str() else {
            continue;
        };
        let Ok(value) = serde_json::from_str::<Value>(raw) else {
            continue;
        };
        if value["output"]["status"] == "superseded" {
            assert_eq!(value["output"]["superseded_by"], latest["output"]["obs"]);
            assert!(
                value["output"]["recovery"]
                    .as_str()
                    .unwrap()
                    .contains("not a tool failure")
            );
        }
    }
    assert!(!last.to_string().contains("data:image/jpeg;base64,data:"));
    let db = rusqlite::Connection::open(s.sandbox.data.join("agent-runtime/btcc.sqlite")).unwrap();
    let session: String = db
        .query_row(
            "SELECT session_id FROM btcc_turns WHERE turn_id=?1",
            [&turn],
            |r| r.get(0),
        )
        .unwrap();
    assert_eq!(
        session, "butler/app-general",
        "tools executed in the user conversation"
    );
    drop(db);
    s.finish().await
}

async fn serve_host(mut stream: reqwest::Response, admin: AdminClient) -> Result<(), HarnessError> {
    let mut buffer = String::new();
    let mut active = std::collections::HashSet::new();
    let mut click = false;
    let mut drag = false;
    let mut points = 0;
    let mut observations = 0;
    loop {
        let frame = super::browser_delegation::next_frame(&mut stream, &mut buffer).await?;
        assert_eq!(frame["session"], "general");
        let op = frame["op"].as_str().unwrap();
        match op {
            "use.started" => {
                active.insert(frame["id"].as_str().unwrap().to_owned());
                continue;
            }
            "use.ended" => {
                assert!(active.remove(frame["args"]["id"].as_str().unwrap()));
                continue;
            }
            "use.finished" => {
                assert!(active.is_empty());
                assert!(click && drag);
                assert_eq!(
                    points, 3,
                    "vision click, drag and scroll cross the public gate"
                );
                return Ok(());
            }
            _ => (),
        }
        let image = json!({"mime_type":"image/jpeg","data":STANDARD.encode(include_bytes!("browser_outputs/pixel.jpg"))});
        let result = match op {
            "tab.open" => {
                let tab = json!({"id":"fixture","owner":"conversation:general","profile":"signed_out","epoch":1,"holder":"agent","inUse":false,"url":"https://example.com"});
                admin
                    .send(
                        Method::POST,
                        "/internal/browser-host/events",
                        Some(json!({"tabs":[tab]})),
                        &[],
                    )
                    .await?;
                json!({"status":"ok","tab":"fixture","url":"https://example.com"})
            }
            "tab.observe" => {
                assert_eq!(frame["args"]["include_image"], true);
                observations += 1;
                if observations == 7 {
                    json!({"status":"ok","tab":"fixture","obs":"obs","text":"Capture unavailable"})
                } else {
                    let pixels = include_bytes!("../../fixtures/browser-route/observation.jpg");
                    json!({"status":"ok","tab":"fixture","obs":"obs","url":"https://example.com","text":"button Confirm [e1]; slider Brightness [e2]; image Dress [e3]","image":{"mime_type":"image/jpeg","data":STANDARD.encode(pixels)}})
                }
            }
            "tab.prepare" => {
                let step = &frame["args"]["steps"][0];
                if step.get("point").is_some() {
                    assert_eq!(step["expect"], "canvas map");
                    json!({"status":"ok","tab":"fixture","url":"https://example.com","steps":[{"hit":{"role":"canvas","name":"Map"},"verification":"unverified"}]})
                } else {
                    json!({"status":"ok","tab":"fixture","url":"https://example.com","steps":[{"hit":{"ref":step["ref"],"role":"slider","name":"Brightness"}}]})
                }
            }
            "tab.waiting" => json!({"status":"ok"}),
            "tab.act" => {
                let step = &frame["args"]["steps"][0];
                let action = step["action"].as_str().unwrap();
                if step.get("point").is_some() {
                    assert_eq!(step["point"], json!([120, 140]));
                    if action == "drag" {
                        assert_eq!(step["target_point"], json!([240, 140]));
                    }
                    points += 1;
                } else if action == "click" {
                    click = true;
                } else {
                    assert_eq!(action, "drag");
                    assert_eq!(frame["args"]["steps"][0]["offset"], json!([100, 0]));
                    drag = true;
                }
                json!({"status":"ok","tab":"fixture","url":"https://example.com","steps":[{"status":"completed"}]})
            }
            "tab.selection" => {
                json!({"status":"ok","tab":"fixture","untrusted_content":{"kind":"web_page_data","elements":[]}})
            }
            "tab.screenshot" => {
                assert!(click && drag);
                assert_eq!(frame["args"]["ref"], "e3");
                json!({"status":"ok","tab":"fixture","url":"https://example.com","image":image})
            }
            _ => panic!("unexpected browser op {op}"),
        };
        let response = admin
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
        assert_eq!(response.status, 200, "{}", response.text);
    }
}

fn cassette() -> Result<Cassette, HarnessError> {
    let template = Cassette::load("TOOL-01")?;
    let mut cassette = Cassette::load("TOOL-01")?;
    cassette.exchanges.clear();
    let names = [
        "browser_open",
        "browser_observe",
        "browser_act",
        "browser_selection",
        "browser_screenshot",
    ];
    let observe = json!({"tab":"fixture","look":"always"});
    let mut calls = vec![
        (
            "tool_search",
            json!({"query":"browser navigate screenshot", "category":"automation"}),
        ),
        (
            "tool_search",
            json!({"query":"browser control screenshot", "provider":"mcp"}),
        ),
        (
            "tool_describe",
            json!({"ids":names.map(|name| format!("native:{name}"))}),
        ),
        (
            "read_operation_results",
            json!({"result_ref":"x","sha256":"x","revision":null,"work_id":null,"offset":0,"length":1}),
        ),
        ("browser_open", json!({"url":"https://example.com"})),
        ("browser_observe", observe.clone()),
        (
            "browser_act",
            json!({"tab":"fixture","observation":"obs","steps":[{"ref":"e1","action":"click"}]}),
        ),
        ("browser_observe", observe.clone()),
        (
            "browser_act",
            json!({"tab":"fixture","observation":"obs","steps":[{"ref":"e2","action":"drag","offset":[100,0]}]}),
        ),
        ("browser_observe", observe.clone()),
        (
            "browser_act",
            json!({"tab":"fixture","observation":"obs","steps":[{"action":"click","point":[120,140],"expect":"canvas map"}]}),
        ),
        ("browser_observe", observe.clone()),
        (
            "browser_act",
            json!({"tab":"fixture","observation":"obs","steps":[{"action":"drag","point":[120,140],"target_point":[240,140],"expect":"canvas map"}]}),
        ),
        ("browser_observe", observe.clone()),
        (
            "browser_act",
            json!({"tab":"fixture","observation":"obs","steps":[{"action":"scroll","point":[120,140],"expect":"canvas map","value":"120"}]}),
        ),
        ("browser_observe", observe.clone()),
        ("browser_selection", json!({"tab":"fixture"})),
        (
            "browser_screenshot",
            json!({"tab":"fixture","observation":"obs","ref":"e3"}),
        ),
    ];
    // A real multi-stop journey observes >2 MiB over time. Old pixels must not
    // prevent the newest viewport from reaching the provider.
    for _ in 0..20 {
        calls.insert(
            calls.len() - 2,
            ("browser_observe", json!({"tab":"fixture"})),
        );
    }
    let mut round = Vec::new();
    for (index, (name, args)) in calls.into_iter().enumerate() {
        let (tool, args) = if matches!(
            name,
            "tool_search" | "tool_describe" | "read_operation_results"
        ) {
            (name, args)
        } else {
            (
                "tool_call",
                json!({"id":format!("native:{name}"),"arguments":args}),
            )
        };
        let mut exchange = template.exchanges[0].clone();
        exchange.request.key.user_request = "Browser journey".into();
        exchange.request.key.round = round.clone();
        exchange.response = super::browser_usage::stub::response(
            &json!({"type":"function_call","id":format!("fc_journey_{index}"),"call_id":format!("call_journey_{index}"),"name":tool,"arguments":args.to_string(),"status":"completed"}),
        );
        cassette.exchanges.push(exchange);
        round.extend(["function_call".into(), "function_call_output".into()]);
    }
    let mut last = template.exchanges[1].clone();
    last.request.key.user_request = "Browser journey".into();
    last.request.key.round = round;
    last.response = super::browser_usage::stub::response(
        &json!({"type":"message","id":"msg_journey","role":"assistant","status":"completed","content":[{"type":"output_text","text":"Done with the attached crop.","annotations":[]}]}),
    );
    cassette.exchanges.push(last);
    Ok(cassette)
}
