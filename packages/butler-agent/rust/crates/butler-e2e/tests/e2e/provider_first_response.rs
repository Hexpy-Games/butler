//! A provider round waits for a slow first response. Until the first
//! response event only the round's total limit applies (a long prefill sends
//! nothing); after it, the idle limit detects a stream that stops. A round
//! that sent nothing by the total limit fails once: resending the same
//! request would repeat the same wait. A Custom model's own response time
//! limit replaces the global total.
//!
//! Limits are scaled down through the existing environment overrides; the
//! defaults are unchanged.
#![allow(
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::panic,
    reason = "test assertions"
)]

use std::time::{Duration, Instant};

use butler_e2e::e2e::HarnessError;
use butler_e2e::e2e::fake_servers::{ChatBehavior, FakeServer, LOCAL_MODEL, Pace};
use butler_e2e::e2e::gateway::turn_state;
use butler_e2e::e2e::scenario::{Scenario, accepted_turn_id};
use serde_json::{Value, json};

use super::setup_local_models::{use_local_model, with_local_server, with_local_server_env};

const IDLE_MS: u64 = 1_000;
/// Longer than any wait here, so a round only the idle limit could end hangs.
const WAIT: Duration = Duration::from_secs(60);
const FIRST_RESPONSE_TIMEOUT: &str = "provider_first_response_timeout";

/// A local model server paced as `pace`, as the default model, with the
/// idle limit at [`IDLE_MS`] and the round total at `total_ms`.
async fn paced(
    id: &str,
    pace: Pace,
    total_ms: u64,
) -> Result<(FakeServer, Scenario), HarnessError> {
    let server = FakeServer::local_models(ChatBehavior {
        pace,
        ..ChatBehavior::default()
    })
    .await?;
    let (idle, total) = (IDLE_MS.to_string(), total_ms.to_string());
    let env = [
        ("BUTLER_PROVIDER_ROUND_IDLE_TIMEOUT_MS", idle.as_str()),
        ("BUTLER_PROVIDER_ROUND_TIMEOUT_MS", total.as_str()),
        ("BUTLER_MODEL_API_RETRY_DELAY_MS", "50"),
    ];
    let s = with_local_server_env(id, &server, &env).await?;
    use_local_model(&s, &server.base_url).await?;
    Ok((server, s))
}

/// The terminal turn for `text`, its answer text and how long it took.
async fn timed_turn(s: &Scenario, text: &str) -> Result<(Value, String, Duration), HarnessError> {
    let started = Instant::now();
    let accepted = s.gw.say("general", text).await?;
    let turn_id = accepted_turn_id(&accepted)?;
    let turn = s.gw.wait_terminal("general", &turn_id, WAIT).await?;
    let elapsed = started.elapsed();
    let answer =
        s.gw.messages("general").await?.into_iter().find(|message| {
            message["role"] == "assistant" && message["turn_id"] == turn_id.as_str()
        });
    let text = answer.map(|m| m["text"].as_str().unwrap_or_default().to_owned());
    Ok((turn, text.unwrap_or_default(), elapsed))
}

/// The streamed round requests the server got.
fn rounds(server: &FakeServer) -> usize {
    server
        .chat_requests()
        .iter()
        .filter(|request| request["stream"] == true)
        .count()
}

/// A first response after the idle limit but before the total arrives and
/// is answered, with one request.
#[tokio::test]
async fn slow_first_response_within_total_is_answered() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    let first_byte = Duration::from_millis(2_500);
    let (server, s) = paced("FIRST-RESPONSE-01", Pace::FirstByteAfter(first_byte), 6_000).await?;
    let (turn, text, elapsed) = timed_turn(&s, "Summarise the long document.").await?;
    eprintln!("FIRST-RESPONSE-01: {} after {elapsed:?}", turn_state(&turn));
    assert_eq!(turn_state(&turn), "delivered", "{turn}");
    assert_eq!(text, ChatBehavior::default().answer);
    assert_eq!(rounds(&server), 1, "the slow round was resent");
    assert!(elapsed >= first_byte, "{elapsed:?}");
    s.finish().await
}

/// Nothing by the total limit: one request, one clear failure.
#[tokio::test]
async fn no_first_response_by_total_fails_once() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    let total = Duration::from_millis(4_000);
    let pace = Pace::FirstByteAfter(Duration::from_secs(120));
    let (server, s) = paced("FIRST-RESPONSE-02", pace, 4_000).await?;
    let (turn, text, elapsed) = timed_turn(&s, "Summarise the long document.").await?;
    eprintln!("FIRST-RESPONSE-02: {} after {elapsed:?}", turn_state(&turn));
    assert_eq!(turn_state(&turn), "failed", "{turn}");
    assert_eq!(turn["safe_error_code"], FIRST_RESPONSE_TIMEOUT, "{turn}");
    assert_eq!(
        text,
        "The model didn't respond within its response timeout."
    );
    assert_eq!(rounds(&server), 1, "the same request was resent");
    assert!(elapsed >= total, "{elapsed:?}");
    butler_e2e::assert_wall_clock_budget!(elapsed, total * 3, "one wait, no retries");
    assert!(s.gw.healthy().await);
    s.finish().await
}

/// A stream that stops after its first chunk is a stall: the idle limit
/// ends it long before the total, and the round is retried as before.
#[tokio::test]
async fn stall_after_first_response_is_retried() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    // Only the idle limit can end the stalled attempt within WAIT.
    let (server, s) = paced("FIRST-RESPONSE-03", Pace::StallFirstAfterOneChunk, 600_000).await?;
    let (turn, text, elapsed) = timed_turn(&s, "Summarise the long document.").await?;
    eprintln!("FIRST-RESPONSE-03: {} after {elapsed:?}", turn_state(&turn));
    assert_eq!(turn_state(&turn), "delivered", "{turn}");
    assert_eq!(text, ChatBehavior::default().answer);
    assert_eq!(rounds(&server), 2, "the stalled round was not retried once");
    assert!(elapsed >= Duration::from_millis(IDLE_MS), "{elapsed:?}");
    s.finish().await
}

/// A stream that never ends keeps resetting the idle limit; the total limit
/// stops it, and that timeout is retried as before.
#[tokio::test]
async fn endless_stream_is_stopped_by_total() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    let total = Duration::from_millis(3_000);
    let pace = Pace::Endless(Duration::from_millis(200));
    let (server, s) = paced("FIRST-RESPONSE-04", pace, 3_000).await?;
    let (turn, _, elapsed) = timed_turn(&s, "Summarise the long document.").await?;
    let attempts = rounds(&server);
    eprintln!(
        "FIRST-RESPONSE-04: {} after {elapsed:?}, {attempts} attempts",
        turn_state(&turn)
    );
    assert_eq!(turn_state(&turn), "failed", "{turn}");
    assert_eq!(turn["safe_error_code"], "provider_round_timeout", "{turn}");
    assert!(
        attempts > 1,
        "a timeout after the first response is retried"
    );
    assert!(
        elapsed >= total * u32::try_from(attempts).unwrap(),
        "{elapsed:?}"
    );
    s.finish().await
}

/// The registration body for the server's model, with `timeout`.
fn registration(server: &FakeServer, timeout: Option<Value>) -> Value {
    let mut body = json!({
        "provider_id": "local", "api_type": "openai_compatible", "platform": "ollama",
        "server_url": server.base_url, "model_id": LOCAL_MODEL,
        "context_window_tokens": 131_072, "source": "discovered"
    });
    if let Some(timeout) = timeout {
        body["response_timeout_ms"] = timeout;
    }
    body
}

/// Saves the model's limit and returns the saved model.
async fn save_timeout(
    s: &Scenario,
    server: &FakeServer,
    timeout: Value,
) -> Result<Value, HarnessError> {
    let path = format!("/model-catalog/local-models/{LOCAL_MODEL}");
    let reply =
        s.gw.patch(&path, registration(server, Some(timeout)))
            .await?;
    assert_eq!(reply.status, 200, "{}", reply.text);
    Ok(reply.data()["model"].clone())
}

/// The model's own limit replaces the global total for its rounds.
#[tokio::test]
async fn custom_model_timeout_replaces_global_total() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    let pace = Pace::FirstByteAfter(Duration::from_millis(3_000));
    let (server, s) = paced("FIRST-RESPONSE-05", pace, 1_500).await?;
    let (turn, _, elapsed) = timed_turn(&s, "First question.").await?;
    eprintln!(
        "FIRST-RESPONSE-05 global: {} after {elapsed:?}",
        turn_state(&turn)
    );
    assert_eq!(turn["safe_error_code"], FIRST_RESPONSE_TIMEOUT, "{turn}");
    let model = save_timeout(&s, &server, json!(8_000)).await?;
    assert_eq!(model["response_timeout_ms"], 8_000, "{model}");
    let (turn, text, elapsed) = timed_turn(&s, "Second question.").await?;
    eprintln!(
        "FIRST-RESPONSE-05 model: {} after {elapsed:?}",
        turn_state(&turn)
    );
    assert_eq!(turn_state(&turn), "delivered", "{turn}");
    assert_eq!(text, ChatBehavior::default().answer);
    assert_eq!(rounds(&server), 2, "one request per turn");
    s.finish().await
}

/// The limit round-trips through the settings API: saved, kept when a save
/// leaves it out, cleared by null, and out-of-range values are refused.
#[tokio::test]
async fn response_timeout_round_trips_through_settings() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    let server = FakeServer::local_models(ChatBehavior::default()).await?;
    let s = with_local_server("FIRST-RESPONSE-06", &server).await?;
    let created =
        s.gw.post(
            "/model-catalog/local-models",
            registration(&server, Some(json!(900_000))),
        )
        .await?;
    assert_eq!(created.status, 201, "{}", created.text);
    assert_eq!(created.data()["model"]["response_timeout_ms"], 900_000);
    let catalog = s.gw.get("/model-catalog").await?;
    let listed = catalog.data()["models"]
        .as_array()
        .unwrap()
        .iter()
        .find(|m| m["model_id"] == LOCAL_MODEL);
    assert_eq!(listed.unwrap()["response_timeout_ms"], 900_000);
    let stored: Value =
        serde_json::from_slice(&std::fs::read(s.sandbox.data.join("butler.config.json"))?)?;
    assert_eq!(stored["models"]["local"][0]["response_timeout_ms"], 900_000);
    let path = format!("/model-catalog/local-models/{LOCAL_MODEL}");
    let kept = s.gw.patch(&path, registration(&server, None)).await?;
    assert_eq!(
        kept.data()["model"]["response_timeout_ms"],
        900_000,
        "{}",
        kept.text
    );
    let max = save_timeout(&s, &server, json!(86_400_000)).await?;
    assert_eq!(max["response_timeout_ms"], 86_400_000);
    for invalid in [
        json!(0),
        json!(999),
        json!(1_500.5),
        json!(86_400_001),
        json!("600000"),
    ] {
        let refused =
            s.gw.patch(&path, registration(&server, Some(invalid.clone())))
                .await?;
        assert_eq!(refused.status, 400, "{invalid}: {}", refused.text);
    }
    let cleared = save_timeout(&s, &server, Value::Null).await?;
    assert!(cleared.get("response_timeout_ms").is_none(), "{cleared}");
    s.finish().await
}
