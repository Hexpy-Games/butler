//! Browsing speed at the agent loop: the core browser tools are on the model's
//! surface (no search/describe rounds), calls on different tabs run in one
//! concurrent batch, and replaced observations never change once written, so
//! each request reuses the previous one's provider prefix.
#![allow(
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::panic,
    reason = "test assertions"
)]
use base64::{Engine, engine::general_purpose::STANDARD};
use butler_e2e::e2e::{
    HarnessError,
    cassette::{Cassette, ResponseRecord},
    scenario::Setup,
    security::AdminClient,
};
use reqwest::Method;
use serde_json::{Value, json};
use std::{
    sync::{
        Arc,
        atomic::{AtomicUsize, Ordering},
    },
    time::{Duration, Instant},
};

/// Each fake tab call takes this long, so a serial batch is visibly slower.
const HOST_DELAY: Duration = Duration::from_millis(400);
const REQUEST: &str = "Compare two shops";

#[tokio::test]
async fn browser_speed_offers_tools_runs_tabs_concurrently_and_keeps_prefix()
-> Result<(), HarnessError> {
    butler_e2e::gate!();
    let s = Setup::new("BROWSER-SPEED")?
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
    let started = Instant::now();
    s.turn("general", REQUEST).await?;
    let turn_ms = started.elapsed().as_millis();
    let peak = tokio::time::timeout(Duration::from_secs(30), host)
        .await
        .unwrap()
        .unwrap()?;
    let requests = s.provider()?.requests();
    let offered: Vec<&str> = requests[0]["tools"]
        .as_array()
        .unwrap()
        .iter()
        .filter_map(|tool| tool["name"].as_str())
        .collect();
    let reuse = prefix_reuse(&requests);
    eprintln!(
        "browser-speed rounds={} turn_ms={turn_ms} peak_tab_calls={peak} prefix_reuse_pct={reuse:?}",
        requests.len()
    );
    for name in [
        "browser_open",
        "browser_observe",
        "browser_act",
        "browser_close",
        "image_collect",
    ] {
        assert!(
            offered.contains(&name),
            "{name} is offered directly: {offered:?}"
        );
    }
    assert_eq!(
        requests.len(),
        8,
        "one model round per batch, no discovery rounds"
    );
    for (index, request) in requests.iter().enumerate().skip(1) {
        for output in outputs(request) {
            assert_ne!(output["ok"], false, "request {index}: {output}");
        }
    }
    assert_eq!(peak, 2, "calls on two tabs ran at the same time");
    // History replaced in an earlier round never changes again.
    for pair in requests.windows(2) {
        let (before, after) = (input(&pair[0]), input(&pair[1]));
        for (old, new) in before.iter().zip(after) {
            if old.to_string().contains("superseded_by") {
                assert_eq!(old, new, "a written stub stays byte-identical");
            }
        }
    }
    let last = outputs(requests.last().unwrap());
    assert_eq!(last.len(), 1, "{last:?}");
    assert_eq!(
        last[0]["output"]["obs"], "b6",
        "the newest observation is complete: {}",
        last[0]
    );
    assert!(last[0].to_string().contains("Price 89,000"));
    s.finish().await
}

/// Per request, the share of the previous request's input it repeats unchanged.
fn prefix_reuse(requests: &[Value]) -> Vec<usize> {
    requests
        .windows(2)
        .map(|pair| {
            let (before, after) = (input(&pair[0]), input(&pair[1]));
            let kept = before.iter().zip(after).take_while(|(a, b)| a == b).count();
            kept * 100 / before.len().max(1)
        })
        .collect()
}

pub(super) fn input(request: &Value) -> &[Value] {
    request["input"].as_array().unwrap()
}

/// The function outputs this request answers for the latest batch.
pub(super) fn outputs(request: &Value) -> Vec<Value> {
    let items = input(request);
    let start = items
        .iter()
        .rposition(|item| item["type"] == "function_call")
        .map_or(0, |last| last + 1);
    items[start..]
        .iter()
        .filter(|item| item["type"] == "function_call_output")
        .map(|item| {
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
        })
        .collect()
}

/// A fake App host: every tab call takes `HOST_DELAY`; returns the peak number
/// of tab calls in flight at once.
async fn serve_host(
    mut stream: reqwest::Response,
    admin: AdminClient,
) -> Result<usize, HarnessError> {
    let mut buffer = String::new();
    let (live, peak) = (Arc::new(AtomicUsize::new(0)), Arc::new(AtomicUsize::new(0)));
    let state = Arc::new(std::sync::Mutex::new(Pages::default()));
    let mut calls = Vec::new();
    loop {
        let frame = super::browser_delegation::next_frame(&mut stream, &mut buffer).await?;
        match frame["op"].as_str().unwrap() {
            "use.started" | "use.ended" => continue,
            "use.finished" => break,
            _ => (),
        }
        let (admin, live, peak, state) = (admin.clone(), live.clone(), peak.clone(), state.clone());
        calls.push(tokio::spawn(async move {
            let now = live.fetch_add(1, Ordering::SeqCst) + 1;
            peak.fetch_max(now, Ordering::SeqCst);
            tokio::time::sleep(HOST_DELAY).await;
            let result = state.lock().unwrap().answer(&frame);
            if frame["op"] == "tab.open" {
                let tabs: Vec<Value> = ["a", "b"].iter().map(|id| json!({"id":id,"owner":"conversation:general","profile":"signed_out","epoch":1,"holder":"agent","inUse":false,"url":format!("https://shop-{id}.example/")})).collect();
                admin.send(Method::POST, "/internal/browser-host/events", Some(json!({"tabs":tabs})), &[]).await?;
            }
            live.fetch_sub(1, Ordering::SeqCst);
            let path = format!("/internal/browser-host/results/{}", frame["id"].as_str().unwrap());
            let response = admin.send(Method::POST, &path, Some(result), &[]).await?;
            assert_eq!(response.status, 200, "{}", response.text);
            Ok::<(), HarnessError>(())
        }));
    }
    for call in calls {
        call.await.unwrap()?;
    }
    Ok(peak.load(Ordering::SeqCst))
}

/// Two shop tabs: one with a cookie banner, one product page whose price
/// shows only after scrolling down.
#[derive(Default)]
struct Pages {
    observations: std::collections::HashMap<String, usize>,
    accepted: bool,
    scrolled: bool,
}

impl Pages {
    fn answer(&mut self, frame: &Value) -> Value {
        let tab = frame["tab"].as_str().unwrap_or_default().to_owned();
        let steps = frame["args"]["steps"]
            .as_array()
            .cloned()
            .unwrap_or_default();
        match frame["op"].as_str().unwrap() {
            "tab.waiting" => json!({"status":"ok"}),
            "tab.open" => {
                let id = if frame["args"]["url"].as_str().unwrap().contains("shop-a") {
                    "a"
                } else {
                    "b"
                };
                json!({"status":"ok","tab":id,"url":format!("https://shop-{id}.example/")})
            }
            "tab.observe" => self.observe(&tab),
            "tab.prepare" => {
                json!({"status":"ok","tab":tab,"url":format!("https://shop-{tab}.example/"),"steps":steps.iter().map(|step| if step["action"] == "press" {
                json!({"keyboard":true,"deferred":true,"hit":{"role":"focus","name":"","frame":""}})
            } else {
                json!({"hit":{"role":"button","name":"Accept","frame":"shop-a.example"}})
            }).collect::<Vec<_>>()})
            }
            "tab.act" => {
                if tab == "a" {
                    self.accepted = true;
                } else {
                    self.scrolled = steps[0]["value"] == "PageDown";
                }
                json!({"status":"ok","tab":tab,"completed":1,"steps":[{"status":"completed","hit":{"role":"document","name":"Shop"}}]})
            }
            op => panic!("unexpected browser op {op}"),
        }
    }

    fn observe(&mut self, tab: &str) -> Value {
        let count = self.observations.entry(tab.to_owned()).or_default();
        *count += 1;
        let text = match (tab, self.accepted, self.scrolled) {
            ("a", false, _) => {
                "heading \"Outer\" [f0-e2]\nWe use cookies\nbutton \"Accept\" [f0-e1]"
            }
            ("a", true, _) => "heading \"Outer\" [f0-e2]\nlink \"Field jacket\" [f0-e3]",
            (_, _, false) => "heading \"Field jacket\" [f0-e2]\nCotton field jacket",
            _ => "button \"Buy\" [f0-e4]\nPrice 89,000 won",
        };
        let pixels = STANDARD.encode(include_bytes!(
            "../../fixtures/browser-route/observation.jpg"
        ));
        json!({"status":"ok","tab":tab,"obs":format!("{tab}{count}"),"url":format!("https://shop-{tab}.example/"),"text":text,
            "image_geometry":{"width":1024,"height":640,"cssWidth":1280,"cssHeight":800},"image":{"mime_type":"image/jpeg","data":pixels}})
    }
}

/// The run's shape: two shops opened and observed side by side, a cookie
/// banner and a scroll in one batch, then the product page scrolled to its
/// price and back.
fn script() -> Vec<Vec<(&'static str, Value)>> {
    let act = |tab: &str, obs: &str, step: Value| {
        (
            "browser_act",
            json!({"tab":tab,"observation":obs,"observe":true,"steps":[step]}),
        )
    };
    let press = |key: &str| json!({"action":"press","value":key});
    vec![
        vec![
            (
                "browser_open",
                json!({"url":"https://shop-a.example/outer"}),
            ),
            (
                "browser_open",
                json!({"url":"https://shop-b.example/jacket"}),
            ),
        ],
        vec![
            ("browser_observe", json!({"tab":"a"})),
            ("browser_observe", json!({"tab":"b"})),
        ],
        vec![
            act("a", "a1", json!({"action":"click","ref":"f0-e1"})),
            act("b", "b1", press("PageDown")),
        ],
        vec![act("b", "b2", press("Home"))],
        vec![act("b", "b3", press("PageDown"))],
        vec![act("b", "b4", press("Home"))],
        vec![act("b", "b5", press("PageDown"))],
    ]
}

fn cassette() -> Result<Cassette, HarnessError> {
    let template = Cassette::load("TOOL-01")?;
    let mut cassette = Cassette::load("TOOL-01")?;
    cassette.exchanges.clear();
    let mut round: Vec<String> = Vec::new();
    for (index, calls) in script().into_iter().enumerate() {
        let mut exchange = template.exchanges[0].clone();
        exchange.request.key.user_request = REQUEST.into();
        exchange.request.key.round = round.clone();
        let items: Vec<Value> = calls
            .iter()
            .enumerate()
            .map(|(n, (name, args))| json!({"type":"function_call","id":format!("fc_speed_{index}_{n}"),"call_id":format!("call_speed_{index}_{n}"),"name":name,"arguments":args.to_string(),"status":"completed"}))
            .collect();
        exchange.response = response(&items);
        cassette.exchanges.push(exchange);
        round.extend(calls.iter().map(|_| "function_call".to_owned()));
        round.extend(calls.iter().map(|_| "function_call_output".to_owned()));
    }
    let mut done = template.exchanges[1].clone();
    done.request.key.user_request = REQUEST.into();
    done.request.key.round = round;
    done.response = response(&[
        json!({"type":"message","id":"msg_speed","role":"assistant","status":"completed","content":[{"type":"output_text","text":"Done.","annotations":[]}]}),
    ]);
    cassette.exchanges.push(done);
    Ok(cassette)
}

/// A streamed response with one or more output items.
pub(super) fn response(items: &[Value]) -> ResponseRecord {
    let mut record = super::browser_usage::stub::response(&items[0]);
    if items.len() == 1 {
        return record;
    }
    let mut events = vec![
        json!({"type":"response.created","response":{"id":"resp_speed","status":"in_progress","output":[]}}),
    ];
    for (index, item) in items.iter().enumerate() {
        events.push(json!({"type":"response.output_item.added","output_index":index,"item":item}));
        events.push(json!({"type":"response.function_call_arguments.done","item_id":item["id"],"output_index":index,"arguments":item["arguments"]}));
        events.push(json!({"type":"response.output_item.done","output_index":index,"item":item}));
    }
    events.push(json!({"type":"response.completed","response":{"id":"resp_speed","object":"response","model":"gpt-6-sol","status":"completed","output":items,"usage":{"input_tokens":100,"output_tokens":20,"total_tokens":120}}}));
    let template = record.chunks[0].clone();
    record.chunks = events
        .into_iter()
        .enumerate()
        .map(|(sequence, mut event)| {
            event["sequence_number"] = json!(sequence);
            let mut chunk = template.clone();
            chunk.text = format!(
                "event: {}\ndata: {event}\n\n",
                event["type"].as_str().unwrap()
            );
            chunk
        })
        .collect();
    record
}
