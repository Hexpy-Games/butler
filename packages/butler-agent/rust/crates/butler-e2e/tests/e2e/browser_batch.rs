//! Continuous batches: keyboard, held-path and modifier steps cross the public
//! gate unchanged, and `observe: true` returns the fresh pixels in the same round.
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
async fn browser_batch_observes_after_keyboard_and_path_steps() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    let s = Setup::new("BROWSER-BATCH")?
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
    s.turn("general", "Browser batch").await?;
    let ops = tokio::time::timeout(Duration::from_secs(10), host)
        .await
        .unwrap()
        .unwrap()?;
    assert_eq!(
        ops,
        [
            "tab.open",
            "tab.observe",
            "tab.prepare",
            "tab.act",
            "tab.observe",
            "tab.prepare",
            "tab.act",
            "tab.observe"
        ],
        "each observe:true batch is followed by exactly one observation"
    );
    let requests = s.provider()?.requests();
    let after_first = act_output(&requests[4]);
    assert_eq!(
        after_first["output"]["schema"],
        "butler.browser-observation.v1"
    );
    assert_eq!(after_first["output"]["obs"], "obs-2");
    assert_eq!(
        after_first["output"]["action"]["schema"],
        "butler.browser-action.v1"
    );
    assert_eq!(after_first["output"]["action"]["completed"], 3);
    assert_eq!(
        after_first["output"]["action"]["steps"][1]["hit"]["kind"],
        "untrusted_web_page_data"
    );
    assert!(!after_first.to_string().contains("still_file"));
    let last = requests.last().unwrap();
    let images = last["input"]
        .as_array()
        .unwrap()
        .iter()
        .filter(|item| item["output"].to_string().contains("input_image"))
        .count();
    assert_eq!(images, 1, "only the newest observation keeps pixels");
    assert!(last.to_string().contains("superseded_by"));
    let latest = act_output(&requests[requests.len() - 2]);
    assert_eq!(latest["output"]["obs"], "obs-3");
    assert_eq!(latest["output"]["action"]["status"], "interrupted");
    assert_eq!(latest["output"]["action"]["next_step_index"], 1);
    let mistyped = act_output(last);
    assert_eq!(mistyped["output"]["reason"], "not_your_tab");
    assert_eq!(
        mistyped["output"]["your_tabs"],
        json!(["fixture"]),
        "a mistyped tab id is corrected from the conversation's own tabs"
    );
    s.finish().await
}

/// The newest function output, decoded from its text part when it carries pixels.
fn act_output(request: &Value) -> Value {
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
            assert!(parts.iter().any(|part| part["type"] == "input_image"));
            parts.iter().find(|p| p["type"] == "input_text").unwrap()["text"]
                .as_str()
                .unwrap()
                .to_owned()
        },
    );
    serde_json::from_str(&text).unwrap()
}

async fn serve_host(
    mut stream: reqwest::Response,
    admin: AdminClient,
) -> Result<Vec<String>, HarnessError> {
    let mut buffer = String::new();
    let mut ops = Vec::new();
    let mut observations = 0;
    loop {
        let frame = super::browser_delegation::next_frame(&mut stream, &mut buffer).await?;
        let op = frame["op"].as_str().unwrap().to_owned();
        match op.as_str() {
            "use.started" | "use.ended" => continue,
            "use.finished" => return Ok(ops),
            _ => (),
        }
        if op != "tab.waiting" {
            ops.push(op.clone());
        }
        let steps = frame["args"]["steps"]
            .as_array()
            .cloned()
            .unwrap_or_default();
        let result = match op.as_str() {
            "tab.waiting" => json!({"status":"ok"}),
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
                observations += 1;
                assert_eq!(frame["args"]["include_image"], true);
                let pixels = include_bytes!("../../fixtures/browser-route/observation.jpg");
                json!({"status":"ok","tab":"fixture","obs":format!("obs-{observations}"),"url":"https://example.com",
                    "text":"textbox Search [e1]; canvas Drawing [e2]","image":{"mime_type":"image/jpeg","data":STANDARD.encode(pixels)}})
            }
            "tab.prepare" => {
                json!({"status":"ok","tab":"fixture","url":"https://example.com","steps":steps.iter().map(|step| match step["action"].as_str().unwrap() {
                    "press" | "type" => json!({"keyboard":true,"deferred":true,"hit":{"role":"focus","name":"","frame":""}}),
                    "wait" => json!({"hit":{"role":"wait","name":"","frame":""}}),
                    _ => json!({"hit":{"role":"canvas","name":"Drawing","ref":"e2"},"verification":"unverified"}),
                }).collect::<Vec<_>>()})
            }
            "tab.act" => act(&frame, &steps),
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

fn act(frame: &Value, steps: &[Value]) -> Value {
    if steps.len() == 3 {
        assert_eq!(frame["args"]["observation"], "obs-1");
        assert_eq!(steps[1], json!({"action":"type","value":"hello"}));
        assert_eq!(steps[2], json!({"action":"press","value":"Enter"}));
        return json!({"status":"ok","tab":"fixture","completed":3,"steps":[
            {"status":"completed","hit":{"role":"textbox","name":"Search"}},
            {"status":"completed","hit":{"role":"textbox","name":"Search"}},
            {"status":"completed","hit":{"role":"textbox","name":"Search"}}]});
    }
    assert_eq!(frame["args"]["observation"], "obs-2");
    assert_eq!(steps[0]["path"], json!([[150, 60], [180, 90]]));
    assert_eq!(steps[0]["modifiers"], json!(["Shift"]));
    json!({"status":"interrupted","tab":"fixture","completed":1,"next_step_index":1,"recovery":"Observe and continue",
        "steps":[{"status":"completed","hit":{"role":"canvas","name":"Drawing"}},{"status":"not_dispatched","reason":"control_changed"}]})
}

fn cassette() -> Result<Cassette, HarnessError> {
    let template = Cassette::load("TOOL-01")?;
    let mut cassette = Cassette::load("TOOL-01")?;
    cassette.exchanges.clear();
    let calls = [
        (
            "tool_describe",
            json!({"ids":["native:browser_open","native:browser_observe","native:browser_act"]}),
        ),
        ("browser_open", json!({"url":"https://example.com"})),
        ("browser_observe", json!({"tab":"fixture"})),
        (
            "browser_act",
            json!({"tab":"fixture","observation":"obs-1","observe":true,"steps":[
                {"action":"click","ref":"e1"},{"action":"type","value":"hello"},{"action":"press","value":"Enter"}]}),
        ),
        (
            "browser_act",
            json!({"tab":"fixture","observation":"obs-2","observe":true,"steps":[
                {"action":"drag","point":[120,140],"path":[[150,60],[180,90]],"target_point":[240,140],"expect":"canvas","modifiers":["Shift"]},
                {"action":"wait","value":"100"}]}),
        ),
        (
            "browser_act",
            json!({"tab":"fixtur","observation":"obs-3","steps":[{"action":"press","value":"Escape"}]}),
        ),
    ];
    let mut round = Vec::new();
    for (index, (name, args)) in calls.into_iter().enumerate() {
        let mut exchange = template.exchanges[0].clone();
        exchange.request.key.user_request = "Browser batch".into();
        exchange.request.key.round = round.clone();
        let (tool, args) = if name == "tool_describe" {
            (name, args)
        } else {
            (
                "tool_call",
                json!({"id":format!("native:{name}"),"arguments":args}),
            )
        };
        exchange.response = super::browser_usage::stub::response(
            &json!({"type":"function_call","id":format!("fc_batch_{index}"),"call_id":format!("call_batch_{index}"),"name":tool,"arguments":args.to_string(),"status":"completed"}),
        );
        cassette.exchanges.push(exchange);
        round.extend(["function_call".into(), "function_call_output".into()]);
    }
    let mut last = template.exchanges[1].clone();
    last.request.key.user_request = "Browser batch".into();
    last.request.key.round = round;
    last.response = super::browser_usage::stub::response(
        &json!({"type":"message","id":"msg_batch","role":"assistant","status":"completed","content":[{"type":"output_text","text":"Done.","annotations":[]}]}),
    );
    cassette.exchanges.push(last);
    Ok(cassette)
}
