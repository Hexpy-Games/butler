//! #1185 — A custom OpenAI-compatible server that refuses the turn's request
//! keeps its error: the provider's status and text reach the turn's failure
//! record and the agent log, and the App shows a few words naming the cause.
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
use butler_e2e::e2e::scenario::{Scenario, accepted_turn_id};
use serde_json::Value;

use super::setup_local_models::{use_local_model, with_local_server};

/// vLLM's reply when it was started without tool-call parsing.
const NO_TOOL_PARSER: &str =
    "\"auto\" tool choice requires --enable-auto-tool-choice and --tool-call-parser to be set";

/// A started scenario whose local server refuses tool requests with `error`.
async fn refusing_server(id: &str, error: &str) -> Result<(FakeServer, Scenario), HarnessError> {
    let behavior = ChatBehavior {
        refuse_tools: Some(error.into()),
        ..ChatBehavior::default()
    };
    let server = FakeServer::local_models(behavior).await?;
    let s = with_local_server(id, &server).await?;
    use_local_model(&s, &server.base_url).await?;
    Ok((server, s))
}

/// Sends `text`; the failed turn's App message text and its durable
/// failure record (the final payload's `runtimeFailure`).
async fn failed_turn(
    s: &Scenario,
    text: &str,
    code: &str,
) -> Result<(String, Value), HarnessError> {
    let accepted = s.gw.say("general", text).await?;
    let turn_id = accepted_turn_id(&accepted)?;
    let turn =
        s.gw.wait_terminal("general", &turn_id, Duration::from_secs(60))
            .await?;
    assert_eq!(turn_state(&turn), "failed", "{turn}");
    assert_eq!(turn["safe_error_code"], code, "{turn}");
    assert_eq!(turn["retryable"], false, "{turn}");
    let answer = s
        .gw
        .messages("general")
        .await?
        .into_iter()
        .find(|message| message["role"] == "assistant" && message["turn_id"] == turn_id.as_str())
        .unwrap();
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
/// the API key never reaches the log.
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

/// CUSTOM-01 — A server without tool-call support refuses every request
/// carrying tools with HTTP 400. The App shows one short sentence in the
/// request's language, the provider error is kept, the refused round is not
/// resent without streaming, and requests without tools carry no
/// `tool_choice`.
#[tokio::test]
async fn custom_01_refused_tools_keep_the_provider_error() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    let (server, s) = refusing_server("CUSTOM-01", NO_TOOL_PARSER).await?;
    let code = "provider_tools_unsupported";
    let (answer, failure) = failed_turn(&s, "Hello there.", code).await?;
    assert_eq!(answer, "This model server doesn't support tool calls.");
    assert_provider_error_kept(&s, &failure, code, NO_TOOL_PARSER);
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
    let ko = "안녕하세요.";
    let accepted = s.gw.say("general", ko).await?;
    let turn_id = accepted_turn_id(&accepted)?;
    s.gw.wait_terminal("general", &turn_id, Duration::from_secs(60))
        .await?;
    let answer =
        s.gw.messages("general").await?.into_iter().find(|message| {
            message["role"] == "assistant" && message["turn_id"] == turn_id.as_str()
        });
    assert_eq!(
        answer.unwrap()["text"],
        "이 모델 서버는 도구 호출을 지원하지 않습니다."
    );
    s.finish().await
}

/// CUSTOM-02 — Any other refused request shows the short provider-error
/// sentence (not an empty or generic turn failure) and keeps the
/// provider's text in the failure record and the log.
#[tokio::test]
async fn custom_02_other_refusals_show_a_short_provider_error() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    let text = "messages: unexpected field";
    let (_server, s) = refusing_server("CUSTOM-02", text).await?;
    let code = "provider_api_error";
    let (answer, failure) = failed_turn(&s, "Hello there.", code).await?;
    assert_eq!(
        answer,
        "A model provider error prevented further work. Progress is saved."
    );
    assert_provider_error_kept(&s, &failure, code, text);
    s.finish().await
}
