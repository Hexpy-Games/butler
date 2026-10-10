//! A long browser task: 65+ observations never hit an image budget, the provider
//! request stays bounded because only the newest observation keeps its pixels,
//! a text-only observation carries no screenshot, and the final capture uses the
//! newest observation.
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

const OBSERVATIONS: usize = 64;

#[tokio::test]
async fn browser_long_run_keeps_newest_pixels_and_bounded_requests() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    let setup = Setup::new("BROWSER-LONG")?.stub_cassette(cassette()?);
    let s = setup.start().await?;
    let admin = AdminClient::new(s.gw.clone(), s.agent.launch.admin_credential().unwrap());
    let stream = reqwest::Client::new()
        .get(format!("{}/internal/browser-host", s.gw.base))
        .bearer_auth(&s.gw.token)
        .header("x-butler-admin", &admin.admin)
        .send()
        .await?;
    let host = tokio::spawn(serve_host(stream, admin));
    s.turn("general", "Long browser task").await?;
    let text_only = tokio::time::timeout(Duration::from_secs(30), host)
        .await
        .unwrap()
        .unwrap()?;
    assert_eq!(
        text_only, 1,
        "exactly the look-never observation skipped the screenshot"
    );
    let requests = s.provider()?.requests();
    let last = requests.last().unwrap().to_string();
    assert!(
        !last.contains("image_budget_exhausted"),
        "no observation hit a budget"
    );
    let capture = output(requests.last().unwrap());
    assert_eq!(
        capture["output"]["schema"], "butler.browser-capture.v1",
        "{capture}"
    );
    assert!(
        capture["output"]["artifacts"][0]["path"]
            .as_str()
            .unwrap()
            .ends_with(".jpg")
    );
    let plain = output(&requests[requests.len() - 3]);
    assert_eq!(
        plain["output"]["status"], "ok",
        "text-only observation: {plain}"
    );
    assert!(plain["output"].get("image").is_none());
    let sizes: Vec<usize> = requests.iter().map(|r| r.to_string().len()).collect();
    for (index, request) in requests.iter().enumerate().skip(3) {
        let images = pictured(request);
        assert!(images <= 2, "request {index} carries {images} images");
        let newest = request["input"]
            .as_array()
            .unwrap()
            .iter()
            .rev()
            .find(|item| item["type"] == "function_call_output")
            .unwrap();
        let text_only_round = index == requests.len() - 3;
        assert_eq!(
            newest["output"].to_string().contains("input_image"),
            !text_only_round,
            "request {index}: the newest observation carries its pixels"
        );
    }
    // Superseded observations shrink to stubs: growth per round is text, not pixels.
    let early = sizes[6];
    let late = sizes[sizes.len() - 4];
    let per_round = (late - early) / (sizes.len() - 10);
    eprintln!(
        "request bytes: first-observation={early} last-observation={late} per-round={per_round} max={}",
        sizes.iter().max().unwrap()
    );
    assert!(
        per_round < 4 * 1024,
        "{per_round} bytes per round: superseded pixels stay out of context"
    );
    s.finish().await
}

fn pictured(request: &Value) -> usize {
    request["input"]
        .as_array()
        .unwrap()
        .iter()
        .filter(|item| item["output"].to_string().contains("input_image"))
        .count()
}

fn output(request: &Value) -> Value {
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
    serde_json::from_str(&text).unwrap()
}

async fn serve_host(
    mut stream: reqwest::Response,
    admin: AdminClient,
) -> Result<usize, HarnessError> {
    let mut buffer = String::new();
    let (mut observations, mut text_only) = (0, 0);
    let pixels = STANDARD.encode(include_bytes!(
        "../../fixtures/browser-route/observation.jpg"
    ));
    loop {
        let frame = super::browser_delegation::next_frame(&mut stream, &mut buffer).await?;
        let op = frame["op"].as_str().unwrap().to_owned();
        let result = match op.as_str() {
            "use.started" | "use.ended" => continue,
            "use.finished" => return Ok(text_only),
            "tab.waiting" => json!({"status":"ok"}),
            "tab.open" => {
                let tab = json!({"id":"t1","owner":"conversation:general","profile":"signed_out","epoch":1,"holder":"agent","inUse":false,"url":"https://example.com/"});
                admin
                    .send(
                        Method::POST,
                        "/internal/browser-host/events",
                        Some(json!({"tabs":[tab]})),
                        &[],
                    )
                    .await?;
                json!({"status":"ok","tab":"t1","url":"https://example.com/"})
            }
            "tab.observe" => {
                observations += 1;
                let mut observed = json!({"status":"ok","tab":"t1","obs":format!("o{observations}"),"url":"https://example.com/",
                    "text":format!("link \"Page {observations}\" [f0-e1]"),"image_geometry":{"width":1024,"height":640,"cssWidth":1280,"cssHeight":800}});
                if frame["args"]["include_image"] == false {
                    text_only += 1;
                } else {
                    observed["image"] = json!({"mime_type":"image/jpeg","data":pixels});
                }
                observed
            }
            "tab.screenshot" => {
                assert_eq!(
                    frame["args"]["observation"],
                    format!("o{observations}"),
                    "capture uses the newest observation"
                );
                json!({"status":"ok","tab":"t1","url":"https://example.com/","source_observation":frame["args"]["observation"],
                    "image":{"mime_type":"image/jpeg","data":pixels}})
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
    let mut calls = vec![
        (
            "tool_describe",
            json!({"ids":["native:browser_open","native:browser_observe","native:browser_screenshot"]}),
        ),
        ("browser_open", json!({"url":"https://example.com/"})),
    ];
    calls.extend((0..OBSERVATIONS).map(|_| ("browser_observe", json!({"tab":"t1"}))));
    calls.push((
        "browser_observe",
        json!({"tab":"t1","scope":"text","look":"never"}),
    ));
    calls.push(("browser_observe", json!({"tab":"t1"})));
    let last = format!("o{}", OBSERVATIONS + 2);
    calls.push((
        "browser_screenshot",
        json!({"tab":"t1","observation":last,"region":[10,10,200,100]}),
    ));
    let mut round = Vec::new();
    for (index, (name, args)) in calls.into_iter().enumerate() {
        let mut exchange = template.exchanges[0].clone();
        exchange.request.key.user_request = "Long browser task".into();
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
            &json!({"type":"function_call","id":format!("fc_long_{index}"),"call_id":format!("call_long_{index}"),"name":tool,"arguments":args.to_string(),"status":"completed"}),
        );
        cassette.exchanges.push(exchange);
        round.extend(["function_call".into(), "function_call_output".into()]);
    }
    let mut done = template.exchanges[1].clone();
    done.request.key.user_request = "Long browser task".into();
    done.request.key.round = round;
    done.response = super::browser_usage::stub::response(
        &json!({"type":"message","id":"msg_long","role":"assistant","status":"completed","content":[{"type":"output_text","text":"Done.","annotations":[]}]}),
    );
    cassette.exchanges.push(done);
    Ok(cassette)
}
