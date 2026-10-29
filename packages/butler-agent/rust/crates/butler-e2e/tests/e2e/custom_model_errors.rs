//! #1185 — A custom OpenAI-compatible server that refuses the turn's request
//! keeps its error: the provider's status and redacted text reach the turn's
//! failure record and the agent log, and the App shows a few words naming the
//! cause. A server without tool calls lets a configured fallback answer.
//! A tool-capable server keeps answering (SETUP-04 covers its stream).
#![allow(
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::panic,
    reason = "test assertions"
)]

use std::time::Duration;

use butler_e2e::e2e::HarnessError;
use butler_e2e::e2e::fake_servers::{ChatBehavior, FakeServer};
use butler_e2e::e2e::gateway::turn_state;
use butler_e2e::e2e::scenario::Scenario;
use serde_json::{Value, json};

use super::setup_local_models::{use_local_model, with_local_server};

const TOOLS_UNSUPPORTED: &str = "provider_tools_unsupported";
const API_ERROR: &str = "provider_api_error";

/// An OpenAI-shaped error body (the shape OpenAI-compatible servers reuse).
fn openai_error(message: &str, param: Option<&str>, code: Option<&str>) -> Value {
    json!({"error": {"message": message, "type": "invalid_request_error",
                     "param": param, "code": code}})
}

/// The server's reply to a model without tool support (Ollama's wording).
fn no_tools_error() -> Value {
    openai_error(
        "registry.ollama.ai/library/llama3.2:latest does not support tools",
        None,
        None,
    )
}

/// A started scenario whose local server refuses tool requests with `error`.
async fn refusing_server(id: &str, error: Value) -> Result<(FakeServer, Scenario), HarnessError> {
    let behavior = ChatBehavior {
        refuse_tools: Some(error),
        ..ChatBehavior::default()
    };
    let server = FakeServer::local_models(behavior).await?;
    let s = with_local_server(id, &server).await?;
    use_local_model(&s, &server.base_url).await?;
    Ok((server, s))
}

/// The terminal turn and its assistant message for `text`.
async fn turn(s: &Scenario, text: &str) -> Result<(Value, Value), HarnessError> {
    let accepted = s.gw.say("general", text).await?;
    let turn_id = s.gw.accepted_turn(&accepted).await?;
    let turn =
        s.gw.wait_terminal("general", &turn_id, Duration::from_secs(60))
            .await?;
    let answer =
        s.gw.messages("general").await?.into_iter().find(|message| {
            message["role"] == "assistant" && message["turn_id"] == turn_id.as_str()
        });
    Ok((turn, answer.unwrap()))
}

/// Sends `text`; the failed turn's App message text and its durable
/// failure record (the final payload's `runtimeFailure`).
async fn failed_turn(
    s: &Scenario,
    text: &str,
    code: &str,
) -> Result<(String, Value), HarnessError> {
    let (turn, answer) = turn(s, text).await?;
    assert_eq!(turn_state(&turn), "failed", "{turn}");
    assert_eq!(turn["safe_error_code"], code, "{turn}");
    assert_eq!(turn["retryable"], false, "{turn}");
    let db = butler_platform::sqlite::open(s.sandbox.data.join("agent-runtime/btcc.sqlite"))?;
    let raw: String = db.query_row(
        "SELECT final_payload_json FROM btcc_turns WHERE final_payload_json LIKE '%runtimeFailure%'",
        [],
        |row| row.get(0),
    )?;
    let payload: Value = serde_json::from_str(&raw)?;
    Ok((
        answer["text"].as_str().unwrap().to_owned(),
        payload["runtimeFailure"].clone(),
    ))
}

/// The failure record and one log line keep the provider's status and text;
/// the registered API key never reaches the log.
fn assert_provider_error_kept(s: &Scenario, failure: &Value, code: &str, text: &str) {
    assert_eq!(failure["code"], code, "{failure}");
    assert_eq!(failure["statusCode"], 400, "{failure}");
    assert_eq!(failure["cause"], text, "{failure}");
    let logs = s.agent.logs();
    assert!(
        logs.lines()
            .any(|line| line.contains(&format!("code={code}"))
                && line.contains("status=400")
                && line.contains(text)),
        "the provider error is not in the log"
    );
    assert!(
        !logs.contains("e2e-custom-private-placeholder"),
        "the API key reached the log"
    );
}

/// CUSTOM-01 — A model without tool support refuses every request carrying
/// tools with HTTP 400. The App shows one short sentence in the app's
/// language, the provider error is kept, the refused round is not resent
/// without streaming, and requests without tools carry no `tool_choice`.
#[tokio::test]
async fn custom_01_refused_tools_keep_the_provider_error() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    let (server, s) = refusing_server("CUSTOM-01", no_tools_error()).await?;
    let (answer, failure) = failed_turn(&s, "Hello there.", TOOLS_UNSUPPORTED).await?;
    assert_eq!(answer, "This model server doesn't support tool calls.");
    let text = no_tools_error()["error"]["message"].clone();
    assert_provider_error_kept(&s, &failure, TOOLS_UNSUPPORTED, text.as_str().unwrap());
    let requests = server.chat_requests();
    let refused: Vec<_> = requests
        .iter()
        .filter(|request| request["tools"].is_array())
        .map(|request| &request["stream"])
        .collect();
    assert_eq!(
        refused.len(),
        1,
        "the refused round was resent: {refused:?}"
    );
    assert!(
        requests
            .iter()
            .all(|request| request["tools"].is_array() || request.get("tool_choice").is_none()),
        "tool_choice was sent without tools"
    );
    let (_, korean_request) = turn(&s, "안녕하세요.").await?;
    assert_eq!(
        korean_request["text"],
        "This model server doesn't support tool calls."
    );
    s.patch_settings(json!({"language":"ko"}), "Korean app language")
        .await?;
    let (_, answer) = turn(&s, "Hello again.").await?;
    assert_eq!(
        answer["text"],
        "이 모델 서버는 도구 호출을 지원하지 않습니다."
    );
    s.finish().await
}

/// CUSTOM-02 — A refusal whose OpenAI error `param` names `tool_choice`
/// is a server without tool calls, whatever its message says.
#[tokio::test]
async fn custom_02_tool_choice_param_means_no_tool_calls() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    let text = "Invalid value for this endpoint.";
    let error = openai_error(text, Some("tool_choice"), None);
    let (_server, s) = refusing_server("CUSTOM-02", error).await?;
    let (answer, failure) = failed_turn(&s, "Hello there.", TOOLS_UNSUPPORTED).await?;
    assert_eq!(answer, "This model server doesn't support tool calls.");
    assert_provider_error_kept(&s, &failure, TOOLS_UNSUPPORTED, text);
    s.finish().await
}

/// CUSTOM-03 — A refusal about the request's own tool history is an
/// ordinary provider error: short sentence, provider text kept.
#[tokio::test]
async fn custom_03_tool_history_errors_stay_provider_errors() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    let text = "An assistant message with 'tool_calls' must be followed by tool messages responding to each 'tool_call_id'.";
    let error = openai_error(text, Some("messages.[2].role"), None);
    let (_server, s) = refusing_server("CUSTOM-03", error).await?;
    let (answer, failure) = failed_turn(&s, "Hello there.", API_ERROR).await?;
    assert_eq!(
        answer,
        "A model provider error prevented further work. Progress is saved."
    );
    assert_provider_error_kept(&s, &failure, API_ERROR, text);
    s.finish().await
}

/// CUSTOM-04 — A key the provider echoes in its error never reaches the
/// failure record or the log.
#[tokio::test]
async fn custom_04_echoed_keys_are_redacted() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    let key = "sk-e2e-echo-0123456789abcdef";
    let text = format!("Incorrect API key provided: {key}. Check the key and retry.");
    let error = openai_error(&text, None, Some("invalid_api_key"));
    let (_server, s) = refusing_server("CUSTOM-04", error).await?;
    let (_, failure) = failed_turn(&s, "Hello there.", API_ERROR).await?;
    assert_eq!(
        failure["cause"], "Incorrect API key provided: [redacted]. Check the key and retry.",
        "{failure}"
    );
    let logs = s.agent.logs();
    assert!(logs.contains("Incorrect API key provided: [redacted]"));
    assert!(!logs.contains(key), "the echoed key reached the log");
    let db = butler_platform::sqlite::open(s.sandbox.data.join("agent-runtime/btcc.sqlite"))?;
    let leaked: i64 = db.query_row(
        "SELECT COUNT(*) FROM btcc_turns WHERE instr(final_payload_json, ?1) > 0",
        [key],
        |row| row.get(0),
    )?;
    assert_eq!(leaked, 0, "the echoed key reached the failure record");
    s.finish().await
}

/// CUSTOM-05 — With a configured fallback model, a server without tool
/// calls hands the turn to the fallback, which answers it.
#[tokio::test]
async fn custom_05_fallback_answers_when_tools_are_refused() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    let (_server, s) = refusing_server("CUSTOM-05", no_tools_error()).await?;
    let backup = FakeServer::local_models(ChatBehavior::default()).await?;
    let reply =
        s.gw.post(
            "/model-catalog/local-models",
            json!({
                "provider_id": "local", "api_type": "openai_compatible", "platform": "custom",
                "server_url": backup.base_url, "model_id": "backup-model",
                "display_name": "backup-model", "context_window_tokens": 131_072,
                "source": "manual"
            }),
        )
        .await?;
    assert_eq!(reply.status, 201, "{}", reply.text);
    let backup_ref = reply.data()["model"]["model_ref"].clone();
    let settings =
        s.gw.patch(
            "/settings",
            json!({"model_fallback": {"enabled": true, "models": [backup_ref]}}),
        )
        .await?;
    assert_eq!(settings.status, 200, "{}", settings.text);
    let (turn, answer) = turn(&s, "Hello there.").await?;
    assert_eq!(turn_state(&turn), "delivered", "{turn}");
    assert_eq!(answer["text"], ChatBehavior::default().answer.as_str());
    assert!(
        backup
            .chat_requests()
            .iter()
            .any(|request| request["tools"].is_array()),
        "the fallback did not get the turn's round"
    );
    s.finish().await
}

#[path = "custom_model_errors/stops.rs"]
mod stops;
