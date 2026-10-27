//! A chat turn whose Anthropic response stops at the output token limit.
#![allow(clippy::unwrap_used, reason = "E2E assertions")]
use axum::{
    Json, Router,
    body::Body,
    extract::State,
    response::{IntoResponse, Response},
    routing::{get, post},
};
use butler_e2e::e2e::{
    HarnessError,
    config::ModelChoice,
    gateway::turn_state,
    scenario::{Scenario, Setup},
};
use serde_json::{Value, json};
use std::sync::{Arc, Mutex};

const MODEL: &str = "claude-opus-5-5";
/// The catalog's max output tokens for `MODEL`.
const CATALOG_OUTPUT: u64 = 128_000;
const PARTIAL: &str = "# Design\n\nThe first part of the answer.\nThe second line is cut";
const CONTINUED: &str = "The second line is cut off here and continues.\nThe end.";
const COMPLETE: &str = "# Design\n\nThe first part of the answer.\nThe second line is cut off here and continues.\nThe end.";

#[derive(Clone)]
pub(super) struct Stub {
    pub(super) requests: Arc<Mutex<Vec<Value>>>,
    tool_cut: bool,
    responses: Arc<Mutex<Vec<String>>>,
    repeat: Arc<Mutex<Option<String>>>,
    fail_after: Arc<Mutex<Option<usize>>>,
    fail_status: Arc<Mutex<u16>>,
}

fn frame(value: &Value) -> String {
    format!(
        "event: {}\ndata: {value}\n\n",
        value["type"].as_str().unwrap()
    )
}

fn start(index: u64, block: &Value) -> String {
    frame(&json!({"type":"content_block_start","index":index,"content_block":block}))
}

fn delta(index: u64, delta: &Value) -> String {
    frame(&json!({"type":"content_block_delta","index":index,"delta":delta}))
}

fn stop(index: u64) -> String {
    frame(&json!({"type":"content_block_stop","index":index}))
}

fn message_start() -> String {
    frame(
        &json!({"type":"message_start","message":{"id":"msg_limit","type":"message","role":"assistant","model":MODEL,"content":[],"usage":{"input_tokens":100,"output_tokens":1}}}),
    )
}

fn message_end(reason: &str, terminator: bool) -> String {
    let mut out = frame(
        &json!({"type":"message_delta","delta":{"stop_reason":reason},"usage":{"output_tokens":4096}}),
    );
    if terminator {
        out.push_str(&frame(&json!({"type":"message_stop"})));
    }
    out
}

/// Output that ends at the limit: the last block is left open, as the
/// interrupted attempts showed. The tool case also ends without `message_stop`.
fn cut_response(tool: bool) -> String {
    let thinking = start(0, &json!({"type":"thinking","thinking":"","signature":""}))
        + &delta(0, &json!({"type":"thinking_delta","thinking":"Planning."}))
        + &delta(0, &json!({"type":"signature_delta","signature":"sig"}))
        + &stop(0);
    if tool {
        return message_start()
            + &thinking
            + &start(1, &json!({"type":"text","text":""}))
            + &delta(
                1,
                &json!({"type":"text_delta","text":"Writing the document."}),
            )
            + &stop(1)
            + &start(
                2,
                &json!({"type":"tool_use","id":"call_cut","name":"tool_call","input":{}}),
            )
            + &delta(
                2,
                &json!({"type":"input_json_delta","partial_json":"{\"id\":\"native:write_file\",\"arguments\":{\"path\":\"design.md\",\"content\":\"# Design"}),
            )
            + &message_end("max_tokens", false);
    }
    message_start()
        + &thinking
        + &start(1, &json!({"type":"text","text":""}))
        + &delta(1, &json!({"type":"text_delta","text":PARTIAL}))
        + &message_end("max_tokens", false)
}

fn text_response(text: &str) -> String {
    message_start()
        + &start(0, &json!({"type":"text","text":""}))
        + &delta(0, &json!({"type":"text_delta","text":text}))
        + &stop(0)
        + &message_end("end_turn", true)
}

async fn reply(State(stub): State<Stub>, Json(body): Json<Value>) -> Response {
    let round = {
        let mut requests = stub.requests.lock().unwrap();
        requests.push(body);
        requests.len()
    };
    if stub
        .fail_after
        .lock()
        .unwrap()
        .is_some_and(|after| round > after)
    {
        return (
            axum::http::StatusCode::from_u16(*stub.fail_status.lock().unwrap()).unwrap(),
            Json(json!({"error":{"type":"invalid_request_error","message":"Invalid request"}})),
        )
            .into_response();
    }
    let scripted = stub.responses.lock().unwrap().get(round - 1).cloned();
    let text = scripted
        .or_else(|| stub.repeat.lock().unwrap().clone())
        .unwrap_or_else(|| match (round, stub.tool_cut) {
            (1, tool) => cut_response(tool),
            (_, false) => text_response(CONTINUED),
            (_, true) => text_response("I will write the document in smaller parts."),
        });
    ([("content-type", "text/event-stream")], Body::from(text)).into_response()
}

async fn setup(
    tool_cut: bool,
) -> Result<(Scenario, Stub, tokio::task::JoinHandle<()>), HarnessError> {
    setup_with_memory(tool_cut, false).await
}

async fn setup_with_memory(
    tool_cut: bool,
    memory: bool,
) -> Result<(Scenario, Stub, tokio::task::JoinHandle<()>), HarnessError> {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await?;
    let base = format!("http://{}/v1", listener.local_addr()?);
    let stub = Stub {
        requests: Arc::default(),
        tool_cut,
        responses: Arc::default(),
        repeat: Arc::default(),
        fail_after: Arc::default(),
        fail_status: Arc::new(Mutex::new(400)),
    };
    let app = Router::new()
        .route("/v1/messages", post(reply))
        .route("/v1/models", get(|| async { Json(json!({"data":[]})) }))
        .with_state(stub.clone());
    let server = tokio::spawn(async move {
        let _ = axum::serve(listener, app).await;
    });
    let setup = Setup::new("ANTHROPIC-OUTPUT-LIMIT")?
        .env("BUTLER_ANTHROPIC_BASE_URL", &base)
        .env("BUTLER_E2E_HOLD_MEMORY_BOOTSTRAP", "1")
        .env("BUTLER_E2E_APP_NOW", "2026-10-02T04:01:00.000Z");
    if memory {
        super::memory_fixture::initialize_empty(&setup.sandbox.data)?;
    }
    let s = setup.start().await?;
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
            json!({"provider_id":"anthropic","model_id":MODEL,"auth_type":"api_key",
                "credential_id":saved.data()["credential"]["id"]}),
        )
        .await?;
    assert_eq!(registered.status, 201, "{}", registered.text);
    let selected = s
        .select_model(&ModelChoice {
            model: format!("anthropic/{MODEL}"),
            effort: None,
        })
        .await?;
    assert_eq!(selected.status, 200, "{}", selected.text);
    stub.requests.lock().unwrap().clear();
    Ok((s, stub, server))
}

/// The rounds of the turn, each with the catalog output limit and none a
/// byte-identical resend of the one before.
fn rounds(stub: &Stub) -> Vec<Value> {
    let bodies = stub.requests.lock().unwrap().clone();
    for body in &bodies {
        assert_eq!(body["max_tokens"].as_u64(), Some(CATALOG_OUTPUT), "{body}");
    }
    for pair in bodies.windows(2) {
        assert_ne!(pair[0], pair[1], "identical resend after max_tokens");
    }
    bodies
}

fn last_user_text(body: &Value) -> String {
    let message = body["messages"].as_array().unwrap().last().unwrap();
    assert_eq!(message["role"], "user");
    message["content"].to_string()
}

#[tokio::test]
async fn anthropic_answer_cut_at_output_limit_continues() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    let (s, stub, server) = setup(false).await?;
    let (id, turn) = s.turn("general", "Rewrite the design document.").await?;
    assert_eq!(turn_state(&turn), "delivered", "{turn}\n{}", s.agent.logs());
    let bodies = rounds(&stub);
    assert_eq!(bodies.len(), 2, "{bodies:?}");
    // The cut answer stays in the transcript and the model is told why.
    let history = bodies[1]["messages"].to_string();
    assert!(history.contains("The second line is cut"), "{history}");
    assert!(last_user_text(&bodies[1]).contains("output token limit"));
    let messages = s.gw.messages("general").await?;
    let answer = messages
        .iter()
        .find(|m| m["role"] == "assistant" && m["turn_id"] == id && m["status"] == "delivered")
        .unwrap();
    assert_eq!(answer["text"], COMPLETE, "{answer}");
    s.finish().await?;
    server.abort();
    Ok(())
}

#[tokio::test]
async fn anthropic_tool_call_cut_at_output_limit_is_not_run() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    let (s, stub, server) = setup(true).await?;
    let (_, turn) = s.turn("general", "Rewrite the design document.").await?;
    assert_eq!(turn_state(&turn), "delivered", "{turn}\n{}", s.agent.logs());
    let bodies = rounds(&stub);
    assert_eq!(bodies.len(), 2, "{bodies:?}");
    let result = bodies[1]["messages"]
        .as_array()
        .unwrap()
        .iter()
        .flat_map(|m| m["content"].as_array().into_iter().flatten())
        .find(|block| block["type"] == "tool_result" && block["tool_use_id"] == "call_cut")
        .cloned()
        .unwrap();
    let feedback = result["content"].to_string();
    assert!(feedback.contains("output_truncated"), "{result}");
    assert!(feedback.contains("output token limit"), "{result}");
    assert!(!s.sandbox.workspace.join("design.md").exists());
    s.finish().await?;
    server.abort();
    Ok(())
}

#[path = "anthropic_output_limit/stops.rs"]
mod stops;

pub(super) async fn setup_briefing(
    text: &str,
) -> Result<(Scenario, Stub, tokio::task::JoinHandle<()>), HarnessError> {
    let (s, stub, server) = setup_with_memory(false, true).await?;
    *stub.responses.lock().unwrap() =
        vec![text_response(text).replace("end_turn", "max_tokens"); 16];
    let settings =
        s.gw.patch(
            "/settings",
            json!({
                "consolidation_model":format!("anthropic/{MODEL}")
            }),
        )
        .await?;
    assert_eq!(settings.status, 200, "{}", settings.text);
    Ok((s, stub, server))
}

#[path = "anthropic_output_limit/replay.rs"]
mod replay;
