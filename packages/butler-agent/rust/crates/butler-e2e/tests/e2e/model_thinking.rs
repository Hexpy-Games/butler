//! Provider summaries travel through the real gateway without durable progress.
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
    events::LiveEvents,
    scenario::{Scenario, Setup},
};
use serde_json::{Value, json};
use std::{
    sync::{Arc, Mutex},
    time::Duration,
};
use tokio::sync::Notify;

const FIRST: &str = "Planning the search";
const SECOND: &str = "Checking the results";
const SIGNATURE: &str = "c3R1Yi1zaWduYXR1cmU=";
const WAIT: Duration = Duration::from_secs(20);
#[derive(Clone)]
struct Stub {
    provider: &'static str,
    raw: bool,
    reject_summary: bool,
    gate: Arc<Notify>,
    requests: Arc<Mutex<Vec<Value>>>,
}
struct Server(tokio::task::JoinHandle<()>);
impl Drop for Server {
    fn drop(&mut self) {
        self.0.abort();
    }
}

fn frame(value: &Value) -> String {
    format!("data: {value}\n\n")
}
fn gemini(part: &Value, end: bool) -> String {
    let mut candidate = json!({"index":0,"content":{"role":"model","parts":[part]}});
    if end {
        candidate["finishReason"] = json!("STOP");
    }
    frame(&json!({"candidates":[candidate],"modelVersion":"gemini-3.8-flash"}))
}
fn frames(stub: &Stub) -> (String, String, String) {
    let a = format!("**{FIRST}**\nDetails.\n");
    let b = format!("**{SECOND}**\nMore details.\n");
    match stub.provider {
        "google" => (
            gemini(&json!({"text":a,"thought":true}), false),
            gemini(&json!({"text":b,"thought":true}), false),
            gemini(
                &json!({"functionCall":{"name":"tool_describe","args":{"ids":["native:list_tool_capabilities"]}},"thoughtSignature":SIGNATURE}),
                true,
            ),
        ),
        "anthropic" => (
            frame(
                &json!({"type":"message_start","message":{"id":"msg_thinking","model":"claude-haiku-4-5","type":"message","role":"assistant","content":[],"usage":{"input_tokens":10,"output_tokens":0}}}),
            ) + &frame(
                &json!({"type":"content_block_start","index":0,"content_block":{"type":"thinking","thinking":"","signature":""}}),
            ) + &frame(
                &json!({"type":"content_block_delta","index":0,"delta":{"type":"thinking_delta","thinking":a}}),
            ),
            frame(
                &json!({"type":"content_block_delta","index":0,"delta":{"type":"thinking_delta","thinking":b}}),
            ),
            frame(
                &json!({"type":"content_block_delta","index":0,"delta":{"type":"signature_delta","signature":SIGNATURE}}),
            ) + &frame(&json!({"type":"content_block_stop","index":0}))
                + &frame(
                    &json!({"type":"content_block_start","index":1,"content_block":{"type":"text","text":""}}),
                )
                + &frame(
                    &json!({"type":"content_block_delta","index":1,"delta":{"type":"text_delta","text":"Done."}}),
                )
                + &frame(&json!({"type":"content_block_stop","index":1}))
                + &frame(
                    &json!({"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":10}}),
                )
                + &frame(&json!({"type":"message_stop"})),
        ),
        _ => {
            let kind = if stub.raw {
                "response.reasoning_text.delta"
            } else {
                "response.reasoning_summary_text.delta"
            };
            (
                frame(&json!({"type":kind,"item_id":"rs_1","output_index":0,"delta":a})),
                frame(&json!({"type":kind,"item_id":"rs_1","output_index":0,"delta":b})),
                frame(&json!({"type":"response.output_text.delta","delta":"Done."}))
                    + &frame(
                        &json!({"type":"response.completed","response":{"id":"resp_done","model":"gpt-5.5","status":"completed","output":[{"type":"message","role":"assistant","content":[{"type":"output_text","text":"Done."}]}],"usage":{"input_tokens":10,"output_tokens":10,"total_tokens":20}}}),
                    ),
            )
        }
    }
}
async fn reply(State(stub): State<Stub>, Json(body): Json<Value>) -> Response {
    if stub.reject_summary && body["reasoning"]["summary"] == "auto" {
        stub.requests.lock().unwrap().push(body);
        return (axum::http::StatusCode::BAD_REQUEST, Json(json!({"error":{"type":"invalid_request_error","param":"reasoning.summary","message":"Summary unavailable"}}))).into_response();
    }
    let round = {
        let mut requests = stub.requests.lock().unwrap();
        requests.push(body);
        requests.len()
    };
    if stub.provider == "google" && round > 1 {
        return (
            [("content-type", "text/event-stream")],
            gemini(&json!({"text":"Done."}), true),
        )
            .into_response();
    }
    let (first, second, last) = frames(&stub);
    let stream = futures_util::stream::unfold(
        (0, stub, first, second, last),
        |(step, stub, first, second, last)| async move {
            let text = match step {
                0 => first.clone(),
                1 => {
                    tokio::time::sleep(Duration::from_millis(300)).await;
                    second.clone()
                }
                2 => {
                    stub.gate.notified().await;
                    last.clone()
                }
                _ => return None,
            };
            Some((
                Ok::<_, std::convert::Infallible>(text),
                (step + 1, stub, first, second, last),
            ))
        },
    );
    (
        [("content-type", "text/event-stream")],
        Body::from_stream(stream),
    )
        .into_response()
}

async fn setup(
    provider: &'static str,
    raw: bool,
) -> Result<(Scenario, Stub, Server), HarnessError> {
    setup_refusal(provider, raw, false).await
}
async fn setup_refusal(
    provider: &'static str,
    raw: bool,
    reject_summary: bool,
) -> Result<(Scenario, Stub, Server), HarnessError> {
    let stub = Stub {
        provider,
        raw,
        reject_summary,
        gate: Arc::new(Notify::new()),
        requests: Default::default(),
    };
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await?;
    let base = format!("http://{}/v1", listener.local_addr()?);
    let model = match provider {
        "google" => "gemini-3.8-flash",
        "anthropic" => "claude-haiku-4-5",
        _ => "gpt-5.5",
    };
    let app = Router::new().route("/v1/models", get(|| async { Json(json!({"data":[],"models":[{"name":"models/gemini-3.8-flash","displayName":"Gemini 3.8 Flash","supportedGenerationMethods":["generateContent"],"inputTokenLimit":1_048_576,"outputTokenLimit":65_536}]})) }))
        .route("/v1/models/gemini-3.8-flash:streamGenerateContent", post(reply))
        .route("/v1/messages", post(reply)).route("/v1/responses", post(reply)).with_state(stub.clone());
    let server = Server(tokio::spawn(async move {
        let _ = axum::serve(listener, app).await;
    }));
    let env = match provider {
        "google" => "BUTLER_GOOGLE_BASE_URL",
        "anthropic" => "BUTLER_ANTHROPIC_BASE_URL",
        _ => "OPENAI_BASE_URL",
    };
    let s = Setup::new("MODEL-THINKING")?
        .env(env, &base)
        .env("BUTLER_E2E_HOLD_MEMORY_BOOTSTRAP", "1")
        .start()
        .await?;
    let key = match provider {
        "google" => "AIza-e2e-placeholder",
        "anthropic" => "sk-ant-e2e-placeholder",
        _ => "sk-e2e-placeholder",
    };
    let saved =
        s.gw.post(
            "/credentials",
            json!({"provider_id":provider,"api_key":key}),
        )
        .await?;
    assert_eq!(saved.status, 201, "{}", saved.text);
    let registered = s.gw.post("/model-catalog/registered-models", json!({"provider_id":provider,"model_id":model,"auth_type":"api_key","credential_id":saved.data()["credential"]["id"]})).await?;
    assert_eq!(registered.status, 201, "{}", registered.text);
    let selected = s
        .select_model(&ModelChoice {
            model: format!("{provider}/{model}"),
            effort: Some("medium".into()),
        })
        .await?;
    assert_eq!(selected.status, 200, "{}", selected.text);
    stub.requests.lock().unwrap().clear();
    Ok((s, stub, server))
}
fn row_counts(s: &Scenario) -> Result<(i64, i64), HarnessError> {
    let app = rusqlite::Connection::open_with_flags(
        s.sandbox.data.join("app-server/butler-client.sqlite"),
        rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY,
    )?;
    let btcc = rusqlite::Connection::open_with_flags(
        s.sandbox.data.join("agent-runtime/btcc.sqlite"),
        rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY,
    )?;
    Ok((
        app.query_row("SELECT COUNT(*) FROM events", [], |row| row.get(0))?,
        btcc.query_row("SELECT COUNT(*) FROM btcc_progress_events", [], |row| {
            row.get(0)
        })?,
    ))
}
async fn summary_case(provider: &'static str) -> Result<(), HarnessError> {
    let (s, stub, _server) = setup(provider, false).await?;
    let live = LiveEvents::subscribe(&s.gw, 0).await?;
    s.gw.say("general", "Reply briefly.").await?;
    let first = live
        .wait_for(WAIT, |e| {
            e["type"] == "turn.thinking" && e["payload"]["line"] == FIRST
        })
        .await?;
    assert!(first.get("id").is_none());
    let before = row_counts(&s)?;
    let second = live
        .wait_for(WAIT, |e| {
            e["type"] == "turn.thinking" && e["payload"]["line"] == SECOND
        })
        .await?;
    assert_eq!(before, row_counts(&s)?, "thinking must not write rows");
    assert_eq!(
        stub.requests.lock().unwrap().len(),
        1,
        "tool frame is still gated"
    );
    let reconnect = LiveEvents::subscribe(&s.gw, 0).await?;
    reconnect
        .wait_for(WAIT, |e| {
            e["type"] == "turn.thinking" && e["payload"]["line"] == SECOND
        })
        .await?;
    assert_eq!(
        reconnect
            .snapshot()
            .iter()
            .filter(|e| e["type"] == "turn.thinking")
            .count(),
        1
    );
    stub.gate.notify_one();
    let turn = second["payload"]["turn_id"].as_str().unwrap();
    live.wait_turn(&s.gw, "general", turn, &["delivered"], WAIT)
        .await?;
    let ended = LiveEvents::subscribe(&s.gw, 0).await?;
    ended
        .wait_for(WAIT, |e| e["type"] == "answer_blocks.snapshot")
        .await?;
    assert!(
        !ended
            .snapshot()
            .iter()
            .any(|e| e["type"] == "turn.thinking")
    );
    let messages = s.gw.messages("general").await?;
    for heading in [FIRST, SECOND] {
        assert!(!json!(messages).to_string().contains(heading));
        assert!(!s.agent.logs().contains(heading));
    }
    assert_no_durable_summary(&s)?;
    assert_wire(&stub);
    eprintln!(
        "{provider}: durable rows {before:?} unchanged; reconnect snapshots=1; gated delivery verified"
    );
    drop((live, reconnect, ended));
    s.finish().await
}
fn assert_no_durable_summary(s: &Scenario) -> Result<(), HarnessError> {
    for (path, table, column) in [
        ("app-server/butler-client.sqlite", "events", "payload_json"),
        (
            "agent-runtime/btcc.sqlite",
            "btcc_progress_events",
            "event_json",
        ),
    ] {
        let db = rusqlite::Connection::open_with_flags(
            s.sandbox.data.join(path),
            rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY,
        )?;
        for heading in [FIRST, SECOND] {
            let count: i64 = db.query_row(
                &format!("SELECT COUNT(*) FROM {table} WHERE instr({column}, ?1)>0"),
                [heading],
                |row| row.get(0),
            )?;
            assert_eq!(count, 0, "summary text persisted in {table}");
        }
    }
    Ok(())
}
fn assert_wire(stub: &Stub) {
    let requests = stub.requests.lock().unwrap();
    let first = &requests[0];
    match stub.provider {
        "google" => {
            assert_eq!(
                first["generationConfig"]["thinkingConfig"]["includeThoughts"],
                true
            );
            assert!(first["generationConfig"]["thinkingConfig"]["thinkingLevel"].is_string());
            let replay = requests[1]["contents"]
                .as_array()
                .unwrap()
                .iter()
                .find(|c| c["role"] == "model")
                .unwrap();
            assert_eq!(
                replay["parts"],
                json!([
                {"text":format!("**{FIRST}**\nDetails.\n**{SECOND}**\nMore details.\n"),"thought":true},
                {"functionCall":{"name":"tool_describe","args":{"ids":["native:list_tool_capabilities"]}},"thoughtSignature":SIGNATURE}])
            );
        }
        "anthropic" => assert_eq!(first["thinking"]["display"], "summarized"),
        _ => assert_eq!(first["reasoning"]["summary"], "auto"),
    }
}
#[tokio::test]
async fn gemini_summary_is_live_only_and_replayed() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    summary_case("google").await
}
#[tokio::test]
async fn anthropic_summary_is_live_only() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    summary_case("anthropic").await
}
#[tokio::test]
async fn responses_summary_is_live_only() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    summary_case("openai").await
}
#[tokio::test]
async fn responses_internal_reasoning_never_reaches_app() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    let (s, stub, _server) = setup("openai", true).await?;
    let live = LiveEvents::subscribe(&s.gw, 0).await?;
    stub.gate.notify_one();
    let (_, turn) = s.turn("general", "Reply briefly.").await?;
    assert_eq!(turn["state"], "delivered");
    assert!(
        !live
            .snapshot()
            .iter()
            .any(|e| e["type"] == "turn.thinking" && e["payload"]["line"].is_string())
    );
    drop(live);
    s.finish().await
}

#[tokio::test]
async fn openai_summary_rejection_resends_once_and_is_remembered() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    let (s, stub, _server) = setup_refusal("openai", false, true).await?;
    for _ in 0..2 {
        stub.gate.notify_one();
        let (_, turn) = s.turn("general", "Reply briefly.").await?;
        assert_eq!(turn["state"], "delivered", "{turn}");
    }
    let requests = stub.requests.lock().unwrap().clone();
    assert_eq!(
        requests.len(),
        3,
        "one rejected request and two accepted rounds"
    );
    assert_eq!(requests[0]["reasoning"]["summary"], "auto");
    for request in &requests[1..] {
        assert!(request["reasoning"].get("summary").is_none());
    }
    s.finish().await
}
