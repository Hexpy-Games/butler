//! Browser history preserves sent prefixes between budgeted batch prunes.
#![allow(
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::panic,
    reason = "E2E assertions"
)]
use base64::{Engine, engine::general_purpose::STANDARD};
use butler_e2e::e2e::{HarnessError, cassette::Cassette, scenario::Setup, security::AdminClient};
use reqwest::Method;
use serde_json::{Value, json};
mod assertions;
use assertions::{assert_journal, assert_prefix};
pub(super) use assertions::{assert_prunes, diagnostics, outputs};

#[tokio::test]
async fn browser_rounds_stay_append_only_until_one_batch_prune() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    run(false).await
}

#[tokio::test]
async fn browser_prune_then_new_turn_answers_correctly() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    run(true).await
}

async fn run(boundary: bool) -> Result<(), HarnessError> {
    let s = Setup::new("BROWSER-PREFIX")?
        .stub_cassette(cassette(boundary)?)
        .env("BUTLER_E2E_HOLD_MEMORY_BOOTSTRAP", "1")
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
    let (id, turn) = s.turn("general", "Browser prefix task").await?;
    assert_eq!(turn["state"], "delivered");
    let first_requests = s.provider()?.requests();
    let first_count = first_requests.len();
    let rows = diagnostics(&s.sandbox.data)?;
    let first_rows: Vec<_> = rows.iter().filter(|r| r["turnId"] == id).cloned().collect();
    assert_prefix(&first_requests, &first_rows);
    assert_journal(&s.sandbox.data, &id, &first_requests)?;
    if boundary {
        let (second_id, second) = s.turn("general", "Look at the tab again").await?;
        assert_eq!(second["state"], "delivered");
        let requests = s.provider()?.requests();
        let later = &requests[first_count..];
        let history = later[0].to_string();
        assert!(history.contains("Browser prefix task") && history.contains("Saw page 14"));
        let rows = diagnostics(&s.sandbox.data)?;
        let rows: Vec<_> = rows.iter().filter(|r| r["turnId"] == second_id).collect();
        assert_eq!(rows.len(), later.len());
        assert!(rows.iter().skip(1).all(|r| r["appendOnly"] == true));
        let newest = outputs(later.last().unwrap()).pop().unwrap();
        assert_eq!(newest.0["output"]["obs"], "o15");
        assert!(newest.1);
        assert!(
            newest.0["output"]["untrusted_content"]["text"]
                .as_str()
                .unwrap()
                .starts_with("link \"Page 15\"")
        );
        let messages = s.gw.messages("general").await?;
        let text = serde_json::to_string(&messages)?;
        assert!(text.contains("Saw page 14") && text.contains("Saw page 15"));
    }
    host.abort();
    let _ = host.await;
    s.finish().await
}

fn cassette(boundary: bool) -> Result<Cassette, HarnessError> {
    let template = Cassette::load("TOOL-01")?;
    let mut cassette = Cassette::load("TOOL-01")?;
    cassette.exchanges.clear();
    let mut calls = vec![
        (
            "tool_describe",
            json!({"ids":["native:browser_open","native:browser_observe","native:browser_act"]}),
        ),
        ("browser_open", json!({"url":"https://example.com/"})),
        ("browser_observe", json!({"tab":"t1"})),
    ];
    calls.extend((1..14).map(|n| ("browser_act", json!({"tab":"t1","observation":format!("o{n}"),"observe":true,"steps":[{"action":"wait","value":"1"}]}))));
    add_turn(
        &mut cassette,
        &template,
        "Browser prefix task",
        calls,
        "Saw page 14",
    );
    if boundary {
        add_turn(
            &mut cassette,
            &template,
            "Look at the tab again",
            vec![
                ("tool_describe", json!({"ids":["native:browser_observe"]})),
                ("browser_observe", json!({"tab":"t1"})),
            ],
            "Saw page 15",
        );
    }
    Ok(cassette)
}

pub(super) fn add_turn(
    cassette: &mut Cassette,
    template: &Cassette,
    user: &str,
    calls: Vec<(&str, Value)>,
    reply: &str,
) {
    let mut round = Vec::new();
    for (index, (name, args)) in calls.into_iter().enumerate() {
        let mut exchange = template.exchanges[0].clone();
        exchange.request.key.user_request = user.into();
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
            &json!({"type":"function_call","id":format!("fc_prefix_{index}"),"call_id":format!("call_prefix_{index}"),"name":tool,"arguments":args.to_string(),"status":"completed"}),
        );
        cassette.exchanges.push(exchange);
        round.extend(["function_call".into(), "function_call_output".into()]);
    }
    let mut done = template.exchanges[1].clone();
    done.request.key.user_request = user.into();
    done.request.key.round = round;
    done.response = super::browser_usage::stub::response(
        &json!({"type":"message","id":"msg_prefix","role":"assistant","status":"completed","content":[{"type":"output_text","text":reply,"annotations":[]}]}),
    );
    cassette.exchanges.push(done);
}

pub(super) async fn serve_host(
    mut stream: reqwest::Response,
    admin: AdminClient,
) -> Result<(), HarnessError> {
    let mut buffer = String::new();
    let mut observations = 0;
    let pixels = STANDARD.encode(include_bytes!(
        "../../fixtures/browser-route/observation.jpg"
    ));
    while let Some(frame) = next_frame(&mut stream, &mut buffer).await? {
        let op = frame["op"].as_str().unwrap().to_owned();
        let result = match op.as_str() {
            "use.started" | "use.ended" | "use.finished" => continue,
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
                    "text":format!("link \"Page {observations}\" [f0-e1]\n{}", "deterministic page content\n".repeat(240)),"image_geometry":{"width":1024,"height":640,"cssWidth":1280,"cssHeight":800}});
                observed["image"] = json!({"mime_type":"image/jpeg","data":pixels});
                observed
            }
            "tab.prepare" => {
                json!({"status":"ok","tab":"t1","url":"https://example.com/","steps":[{"hit":{"role":"wait","name":"","frame":""}}]})
            }
            "tab.act" => {
                json!({"status":"ok","tab":"t1","completed":1,"steps":[{"status":"completed","hit":{"role":"wait","name":"","frame":""}}]})
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
    Ok(())
}

pub(super) async fn next_frame(
    stream: &mut reqwest::Response,
    buffer: &mut String,
) -> Result<Option<Value>, HarnessError> {
    loop {
        if let Some(end) = buffer.find("\n\n") {
            let event = buffer[..end].to_owned();
            buffer.drain(..end + 2);
            if let Some(data) = event.lines().find_map(|line| line.strip_prefix("data: ")) {
                return Ok(Some(serde_json::from_str(data)?));
            }
        } else if let Some(chunk) = stream.chunk().await? {
            buffer.push_str(std::str::from_utf8(&chunk).unwrap());
        } else {
            return Ok(None);
        }
    }
}
