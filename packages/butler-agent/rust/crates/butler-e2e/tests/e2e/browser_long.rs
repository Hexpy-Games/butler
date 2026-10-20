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
    let started = std::time::Instant::now();
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
    eprintln!("browser-long setup_ms={}", started.elapsed().as_millis());
    let turn_started = std::time::Instant::now();
    let (turn_id, turn) = s.turn("general", "Long browser task").await?;
    assert_eq!(turn["state"], "delivered");
    eprintln!(
        "browser-long turn_ms={}",
        turn_started.elapsed().as_millis()
    );
    let text_only = tokio::time::timeout(Duration::from_secs(30), host)
        .await
        .unwrap()
        .unwrap()?;
    assert_eq!(
        text_only, 1,
        "exactly the look-never observation skipped the screenshot"
    );
    let requests = s.provider()?.requests();
    assert_observations(&requests);
    let last = requests.last().unwrap().to_string();
    assert!(
        !last.contains("image_budget_exhausted"),
        "no observation hit a budget"
    );
    let capture = output(requests.last().unwrap());
    assert_eq!(capture["output"]["status"], "ok", "{capture}");
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
    let byte_limit = byte_limit(&s.model.model);
    let rows = super::browser_prefix::diagnostics(&s.sandbox.data)?;
    let rows: Vec<_> = rows
        .into_iter()
        .filter(|row| row["turnId"] == turn_id)
        .collect();
    super::browser_prefix::assert_prunes(&requests, &rows);
    let sizes: Vec<usize> = requests.iter().map(|r| r.to_string().len()).collect();
    let pixels = format!(
        "data:image/jpeg;base64,{}",
        STANDARD.encode(include_bytes!(
            "../../fixtures/browser-route/observation.jpg"
        ))
    );
    for (index, request) in requests.iter().enumerate().skip(3) {
        let stale_bytes = stale_full_bytes(request);
        assert!(
            stale_bytes <= byte_limit * 3 / 8,
            "request {index} has {stale_bytes} stale full bytes (limit {byte_limit})"
        );
        let newest = request["input"]
            .as_array()
            .unwrap()
            .iter()
            .rev()
            .find(|item| item["type"] == "function_call_output")
            .unwrap();
        if let Some(parts) = newest["output"].as_array() {
            for image in parts.iter().filter(|part| part["type"] == "input_image") {
                assert_eq!(
                    image["image_url"],
                    format!(
                        "data:image/jpeg;base64,{}",
                        STANDARD.encode(frame_bytes(index - 2))
                    ),
                    "complete pixels at request {index}"
                );
            }
        }
        let text_only_round = index == requests.len() - 3;
        assert_eq!(
            newest["output"].to_string().contains("input_image"),
            !text_only_round,
            "request {index}: the newest observation carries its pixels"
        );
    }
    let early = sizes[3];
    let newest = pixels.len() + 16 * 1024;
    let maximum = *sizes.iter().max().unwrap();
    eprintln!(
        "request bytes: first-observation={early} last-observation={} max={maximum} byte-limit={byte_limit}",
        sizes[sizes.len() - 4]
    );
    assert!(
        maximum <= early + newest + byte_limit * 3 / 8,
        "max request {maximum} exceeds first observation + newest + stale guard"
    );
    assert_uploaded_pixels(&s).await?;
    s.finish().await
}

fn assert_observations(requests: &[Value]) {
    let observations: Vec<_> = requests
        .iter()
        .skip(1)
        .map(output)
        .filter(|result| result["output"]["schema"] == "butler.browser-observation.v1")
        .collect();
    assert_eq!(observations.len(), OBSERVATIONS + 2);
    for (index, result) in observations.iter().enumerate() {
        let observed = &result["output"];
        assert_eq!(observed["status"], "ok", "{result}");
        assert_eq!(observed["obs"], format!("o{}", index + 1));
        assert_eq!(
            observed["untrusted_content"]["text"],
            format!("link \"Page {}\" [f0-e1]", index + 1)
        );
        if index != OBSERVATIONS {
            assert_eq!(
                observed["image_geometry"],
                json!({"width":1024,"height":640,"cssWidth":1280,"cssHeight":800})
            );
        }
    }
}

fn byte_limit(model: &str) -> usize {
    let catalog: Value = serde_json::from_str(include_str!(
        "../../../butler-models/src/models/catalog/static-catalog.json"
    ))
    .unwrap();
    let model = catalog["models"]
        .as_array()
        .unwrap()
        .iter()
        .find(|row| row["model_ref"] == model)
        .unwrap();
    usize::try_from(
        model["context_window_tokens"]
            .as_u64()
            .unwrap_or(200_000)
            .saturating_mul(2)
            .clamp(192 * 1024, 4 * 1024 * 1024),
    )
    .unwrap()
}

fn stale_full_bytes(request: &Value) -> usize {
    let mut observations = super::browser_prefix::outputs(request);
    observations.pop();
    observations
        .into_iter()
        .filter(|(v, _)| v["output"]["status"] != "superseded")
        .map(|(v, image)| {
            v.to_string().len()
                + if image {
                    STANDARD
                        .encode(include_bytes!(
                            "../../fixtures/browser-route/observation.jpg"
                        ))
                        .len()
                } else {
                    0
                }
        })
        .sum()
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

pub(super) async fn serve_host(
    mut stream: reqwest::Response,
    admin: AdminClient,
) -> Result<usize, HarnessError> {
    let mut buffer = String::new();
    let (mut observations, mut text_only) = (0, 0);
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
                    observed["image"] = json!({"mime_type":"image/jpeg","data":STANDARD.encode(frame_bytes(observations))});
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
                    "image":{"mime_type":"image/jpeg","data":STANDARD.encode(frame_bytes(observations + 1))}})
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

async fn assert_uploaded_pixels(
    s: &butler_e2e::e2e::scenario::Scenario,
) -> Result<(), HarnessError> {
    // The provider's visual projection removes image.file from its text part.
    // Check the durable upload identities, including the final capture, instead.
    let files = {
        let db = rusqlite::Connection::open_with_flags(
            s.sandbox.data.join("app-server/butler-client.sqlite"),
            rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY,
        )?;
        let mut query = db.prepare(
            "SELECT id FROM message_files WHERE safe_name='browser-observation.jpg' ORDER BY rowid",
        )?;
        query
            .query_map([], |row| row.get::<_, String>(0))?
            .collect::<Result<Vec<_>, _>>()?
    };
    assert_eq!(
        files.len(),
        OBSERVATIONS + 2,
        "every pictured observation and capture has a file"
    );
    let unique: std::collections::HashSet<_> = files.iter().collect();
    assert_eq!(
        unique.len(),
        files.len(),
        "uploads retain distinct identities"
    );
    for (index, file) in files.into_iter().enumerate() {
        let response =
            s.gw.http()
                .get(format!("{}/message-files/{file}", s.gw.base))
                .bearer_auth(&s.gw.token)
                .send()
                .await?;
        assert_eq!(response.status(), 200);
        assert_eq!(
            response.bytes().await?.as_ref(),
            frame_bytes(if index < OBSERVATIONS {
                index + 1
            } else {
                index + 2
            })
        );
    }
    Ok(())
}

pub(super) fn frame_bytes(index: usize) -> Vec<u8> {
    let mut bytes = include_bytes!("../../fixtures/browser-route/observation.jpg").to_vec();
    // JPEG decoders ignore bytes after EOI. Retain valid, complete pixels while
    // requiring a distinct durable payload for every observation and capture.
    bytes.extend_from_slice(&u16::try_from(index).unwrap().to_be_bytes());
    bytes
}
