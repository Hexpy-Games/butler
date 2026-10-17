//! Signed reasoning must survive only unchanged request prefixes and predecessors.
#![allow(clippy::unwrap_used, reason = "E2E assertions")]
use axum::{
    Json, Router,
    extract::State,
    http::StatusCode,
    routing::{get, post},
};
use base64::{Engine, engine::general_purpose::STANDARD};
use butler_e2e::e2e::{
    HarnessError,
    config::ModelChoice,
    scenario::{Scenario, Setup},
    security::AdminClient,
};
use serde_json::{Value, json};
use std::{
    collections::{BTreeMap, BTreeSet},
    sync::{Arc, Mutex},
};

type Minted = BTreeMap<String, (Value, Option<String>)>;
#[derive(Default)]
struct Stub {
    requests: Vec<Value>,
    minted: Minted,
    rejections: Vec<String>,
}

fn reasoning(block: &Value) -> bool {
    matches!(
        block["type"].as_str(),
        Some("thinking" | "redacted_thinking")
    )
}
fn clean(value: &Value) -> Value {
    match value {
        Value::Object(map) => Value::Object(
            map.iter()
                .filter(|(k, _)| *k != "cache_control")
                .map(|(k, v)| (k.clone(), clean(v)))
                .collect(),
        ),
        Value::Array(items) => Value::Array(items.iter().map(clean).collect()),
        _ => value.clone(),
    }
}
fn canonical(body: &Value, end: usize) -> Value {
    let system = body["system"]
        .as_str()
        .map(str::to_owned)
        .unwrap_or_else(|| {
            body["system"]
                .as_array()
                .into_iter()
                .flatten()
                .filter_map(|b| b["text"].as_str())
                .collect()
        });
    let mut tools = body["tools"].as_array().cloned().unwrap_or_default();
    tools.sort_by(|a, b| a["name"].as_str().cmp(&b["name"].as_str()));
    let messages: Vec<_> = body["messages"].as_array().unwrap()[..end]
        .iter()
        .filter_map(|m| {
            let content = if let Some(s) = m["content"].as_str() {
                vec![json!({"type":"text","text":s})]
            } else {
                m["content"]
                    .as_array()
                    .unwrap()
                    .iter()
                    .filter(|b| !reasoning(b))
                    .cloned()
                    .collect()
            };
            if m["role"] == "assistant" && content.is_empty() {
                return None;
            }
            Some(json!({"role":m["role"],"content":content}))
        })
        .collect();
    clean(&json!({"system":system,"tools":tools,"messages":messages}))
}
fn signatures(body: &Value) -> Vec<String> {
    body["messages"]
        .as_array()
        .unwrap()
        .iter()
        .flat_map(|m| m["content"].as_array().into_iter().flatten())
        .filter(|b| reasoning(b))
        .map(|b| {
            b["signature"]
                .as_str()
                .or_else(|| b["data"].as_str())
                .unwrap()
                .to_owned()
        })
        .collect()
}
fn verify(body: &Value, minted: &Minted) -> Result<(), String> {
    let mut previous = None;
    for (i, message) in body["messages"].as_array().unwrap().iter().enumerate() {
        let before = previous.clone();
        for (j, block) in message["content"]
            .as_array()
            .into_iter()
            .flatten()
            .enumerate()
        {
            if !reasoning(block) {
                continue;
            }
            let allowed = if block["type"] == "thinking" {
                &["type", "thinking", "signature"][..]
            } else {
                &["type", "data"][..]
            };
            if block
                .as_object()
                .unwrap()
                .keys()
                .any(|k| !allowed.contains(&k.as_str()))
            {
                return Err("Extra inputs are not permitted".into());
            }
            let sig = block["signature"]
                .as_str()
                .or_else(|| block["data"].as_str())
                .unwrap();
            let Some((prefix, after)) = minted.get(sig) else {
                return Err(format!("unknown signature {sig}"));
            };
            if *prefix != canonical(body, i) || *after != before {
                return Err(format!(
                    "messages.{i}.content.{j}: Invalid `signature` in `thinking` block. The block is bound to a different conversation."
                ));
            }
            previous = Some(sig.to_owned());
        }
    }
    Ok(())
}
fn result<'a>(body: &'a Value, id: &str) -> Option<&'a Value> {
    body["messages"]
        .as_array()
        .unwrap()
        .iter()
        .flat_map(|m| m["content"].as_array().into_iter().flatten())
        .find(|b| b["type"] == "tool_result" && b["tool_use_id"] == id)
}
fn step(body: &Value) -> Option<Value> {
    let steps = [
        (
            "toolu_describe",
            "tool_describe",
            json!({"ids":["native:browser_open","native:browser_observe"]}),
        ),
        (
            "toolu_open",
            "tool_call",
            json!({"id":"native:browser_open","arguments":{"url":"https://example.com/"}}),
        ),
        (
            "toolu_observe_1",
            "tool_call",
            json!({"id":"native:browser_observe","arguments":{"tab":"t1"}}),
        ),
        (
            "toolu_observe_2",
            "tool_call",
            json!({"id":"native:browser_observe","arguments":{"tab":"t1"}}),
        ),
        (
            "toolu_describe_2",
            "tool_describe",
            json!({"ids":["native:browser_screenshot"]}),
        ),
    ];
    steps
        .into_iter()
        .find(|(id, _, _)| result(body, id).is_none())
        .map(|(id, name, input)| json!({"type":"tool_use","id":id,"name":name,"input":input}))
}
async fn reply(
    State(stub): State<Arc<Mutex<Stub>>>,
    Json(body): Json<Value>,
) -> (StatusCode, Json<Value>) {
    let mut stub = stub.lock().unwrap();
    let active = body["tools"].as_array().is_some_and(|t| !t.is_empty());
    let mut content = vec![json!({"type":"text","text":"Observed the page twice."})];
    let mut stop = "end_turn";
    if active {
        stub.requests.push(body.clone());
        if let Err(error) = verify(&body, &stub.minted) {
            stub.rejections.push(error.clone());
            return (
                StatusCode::BAD_REQUEST,
                Json(
                    json!({"type":"error","error":{"type":"invalid_request_error","message":error}}),
                ),
            );
        }
        if let Some(tool) = step(&body) {
            content = vec![tool];
            stop = "tool_use";
        }
        let sig = format!("sig-{}", stub.minted.len() + 1);
        stub.minted.insert(
            sig.clone(),
            (
                canonical(&body, body["messages"].as_array().unwrap().len()),
                signatures(&body).last().cloned(),
            ),
        );
        content.insert(0, json!({"type":"thinking","thinking":"","signature":sig}));
    }
    (
        StatusCode::OK,
        Json(
            json!({"id":"msg_history","type":"message","role":"assistant","model":body["model"],
        "content":content,"stop_reason":stop,"usage":{"input_tokens":100,"output_tokens":10}}),
        ),
    )
}
async fn start() -> Result<(Scenario, Arc<Mutex<Stub>>, tokio::task::JoinHandle<()>), HarnessError>
{
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await?;
    let base = format!("http://{}/v1", listener.local_addr()?);
    let stub = Arc::new(Mutex::new(Stub::default()));
    let app = Router::new()
        .route("/v1/messages", post(reply))
        .route("/v1/models", get(|| async { Json(json!({"data":[]})) }))
        .layer(axum::extract::DefaultBodyLimit::max(32 * 1024 * 1024))
        .with_state(stub.clone());
    let server = tokio::spawn(async move {
        let _ = axum::serve(listener, app).await;
    });
    let s = Setup::new("ANTHROPIC-THINKING-HISTORY")?
        .env("BUTLER_ANTHROPIC_BASE_URL", &base)
        .env(
            "BUTLER_ANTHROPIC_CACHE_VERIFIED_ENDPOINT",
            format!("{base}/messages"),
        )
        .env("BUTLER_E2E_HOLD_MEMORY_BOOTSTRAP", "1")
        .start()
        .await?;
    let saved =
        s.gw.post(
            "/credentials",
            json!({"provider_id":"anthropic","api_key":"sk-ant-e2e-placeholder"}),
        )
        .await?;
    assert_eq!(saved.status, 201, "{}", saved.text);
    let registered =
        s.gw.post(
            "/model-catalog/registered-models",
            json!({"provider_id":"anthropic","model_id":"claude-sonnet-5",
        "auth_type":"api_key","credential_id":saved.data()["credential"]["id"]}),
        )
        .await?;
    assert_eq!(registered.status, 201, "{}", registered.text);
    let selected = s
        .select_model(&ModelChoice {
            model: "anthropic/claude-sonnet-5".into(),
            effort: None,
        })
        .await?;
    assert_eq!(selected.status, 200, "{}", selected.text);
    Ok((s, stub, server))
}
#[tokio::test]
async fn anthropic_thinking_history_survives_browser_rewrite() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    let (s, stub, server) = start().await?;
    let admin = AdminClient::new(s.gw.clone(), s.agent.launch.admin_credential().unwrap());
    let stream = reqwest::Client::new()
        .get(format!("{}/internal/browser-host", s.gw.base))
        .bearer_auth(&s.gw.token)
        .header("x-butler-admin", &admin.admin)
        .send()
        .await?;
    let host = tokio::spawn(super::browser_long::serve_host(stream, admin));
    let (_, turn) = s.turn("general", "Observe the page twice.").await?;
    let (bodies, minted, rejections) = {
        let stub = stub.lock().unwrap();
        (
            stub.requests.clone(),
            stub.minted.clone(),
            stub.rejections.clone(),
        )
    };
    assert_eq!(
        turn["state"], "delivered",
        "rejections={rejections:?}; turn={turn}"
    );
    let messages = s.gw.messages("general").await?;
    let last = messages.last().unwrap();
    assert_eq!(last["role"], "assistant");
    assert_eq!(last["text"], "Observed the page twice.");
    assert!(rejections.is_empty(), "{rejections:?}");
    for body in &bodies {
        verify(body, &minted).unwrap();
        assert!(!body.to_string().contains("butler_binding"));
    }
    let r4 = bodies
        .iter()
        .find(|b| result(b, "toolu_observe_1").is_some())
        .unwrap();
    let r5 = bodies
        .iter()
        .find(|b| result(b, "toolu_observe_2").is_some())
        .unwrap();
    let r6 = bodies
        .iter()
        .find(|b| result(b, "toolu_describe_2").is_some())
        .unwrap();
    let old = result(r5, "toolu_observe_1").unwrap();
    let text = old["content"]
        .as_str()
        .or_else(|| old["content"][0]["text"].as_str())
        .unwrap();
    let output: Value = serde_json::from_str(text)?;
    assert_eq!(output["output"]["status"], "superseded", "{old}");
    let newest = result(r5, "toolu_observe_2").unwrap();
    let image = newest["content"]
        .as_array()
        .unwrap()
        .iter()
        .find(|b| b["type"] == "image")
        .unwrap();
    assert_eq!(
        image["source"]["data"],
        STANDARD.encode(include_bytes!(
            "../../fixtures/browser-route/observation.jpg"
        ))
    );
    for (body, expected) in [
        (r5, vec!["sig-1", "sig-2", "sig-3"]),
        (r6, vec!["sig-1", "sig-2", "sig-3", "sig-5"]),
    ] {
        assert_eq!(
            signatures(body).into_iter().collect::<BTreeSet<_>>(),
            expected.into_iter().map(str::to_owned).collect()
        );
    }
    let mut invalid = r5.clone();
    let message = invalid["messages"]
        .as_array_mut()
        .unwrap()
        .iter_mut()
        .find(|m| {
            m["content"]
                .as_array()
                .is_some_and(|c| c.iter().any(|b| b["id"] == "toolu_observe_2"))
        })
        .unwrap();
    message["content"].as_array_mut().unwrap().insert(
        0,
        json!({"type":"thinking","thinking":"","signature":"sig-4"}),
    );
    assert!(
        verify(&invalid, &minted)
            .unwrap_err()
            .contains("bound to a different conversation")
    );
    for (name, body) in [("R4", r4), ("R5", r5), ("R6", r6)] {
        let groups = body["messages"]
            .as_array()
            .unwrap()
            .iter()
            .filter(|m| {
                m["role"] == "assistant"
                    && m["content"]
                        .as_array()
                        .is_some_and(|blocks| blocks.iter().any(|b| b["type"] == "tool_use"))
            })
            .count();
        let stripped = groups - signatures(body).len();
        eprintln!(
            "{name} request_bytes={} stripped_reasoning_groups={stripped}",
            body.to_string().len()
        );
    }
    tokio::time::timeout(std::time::Duration::from_secs(30), host)
        .await
        .unwrap()
        .unwrap()?;
    s.finish().await?;
    server.abort();
    Ok(())
}
