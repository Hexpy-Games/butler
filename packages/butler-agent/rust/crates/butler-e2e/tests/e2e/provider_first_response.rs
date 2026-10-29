//! A provider round waits for a slow first response. Until the attempt's
//! first output event (text, reasoning or a tool call) only the round's total
//! limit applies: a long prefill sends nothing, or only headers or a role
//! chunk. After it, the idle limit detects a stream that stops. A round that
//! sent no output by the total limit fails once without resending the same
//! request (a fallback model still answers). A Custom model's own response
//! time limit replaces the global total.
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

#[path = "provider_first_response/early_events.rs"]
mod early_events;
#[path = "provider_first_response/fallback.rs"]
mod fallback;
#[path = "provider_first_response/settings.rs"]
mod settings;

const IDLE_MS: u64 = 1_000;
/// Longer than any wait here, so a round only the idle limit could end hangs.
const WAIT: Duration = Duration::from_secs(60);
const FIRST_RESPONSE_TIMEOUT: &str = "provider_first_response_timeout";
const PROMPT: &str = "Summarise the long document.";

/// A local model server paced as `pace`, as the default model, with the
/// idle limit at [`IDLE_MS`], the round total at `total_ms`, and `extra`.
async fn paced_with(
    id: &str,
    pace: Pace,
    total_ms: u64,
    extra: &[(&str, &str)],
) -> Result<(FakeServer, Scenario), HarnessError> {
    let server = FakeServer::local_models(ChatBehavior {
        pace,
        ..ChatBehavior::default()
    })
    .await?;
    let (idle, total) = (IDLE_MS.to_string(), total_ms.to_string());
    let mut env = vec![
        ("BUTLER_PROVIDER_ROUND_IDLE_TIMEOUT_MS", idle.as_str()),
        ("BUTLER_PROVIDER_ROUND_TIMEOUT_MS", total.as_str()),
        ("BUTLER_MODEL_API_RETRY_DELAY_MS", "50"),
    ];
    env.extend_from_slice(extra);
    let s = with_local_server_env(id, &server, &env).await?;
    use_local_model(&s, &server.base_url).await?;
    Ok((server, s))
}

async fn paced(
    id: &str,
    pace: Pace,
    total_ms: u64,
) -> Result<(FakeServer, Scenario), HarnessError> {
    paced_with(id, pace, total_ms, &[]).await
}

/// A terminal turn: its record, id, answer text and how long it took.
struct Ended {
    turn: Value,
    id: String,
    text: String,
    elapsed: Duration,
}

async fn timed_turn(s: &Scenario, text: &str) -> Result<Ended, HarnessError> {
    let started = Instant::now();
    let accepted = s.gw.say("general", text).await?;
    let id = accepted_turn_id(&accepted)?;
    let turn = s.gw.wait_terminal("general", &id, WAIT).await?;
    let elapsed = started.elapsed();
    let text = answer(s, &id).await?;
    Ok(Ended {
        turn,
        id,
        text,
        elapsed,
    })
}

async fn answer(s: &Scenario, turn_id: &str) -> Result<String, HarnessError> {
    let answer =
        s.gw.messages("general")
            .await?
            .into_iter()
            .find(|message| message["role"] == "assistant" && message["turn_id"] == turn_id);
    Ok(answer
        .map(|m| m["text"].as_str().unwrap_or_default().to_owned())
        .unwrap_or_default())
}

/// Every turn-round request the server got, streamed or not, so a resend
/// in either form counts. A round carries the turn's tools; background
/// requests (session title, briefing, memory extraction) carry none.
fn rounds(server: &FakeServer) -> usize {
    let requests = server.chat_requests();
    let rounds = requests
        .iter()
        .filter(|r| r["tools"].as_array().is_some_and(|tools| !tools.is_empty()))
        .count();
    let streamed = requests.iter().filter(|r| r["stream"] == true).count();
    eprintln!(
        "chat requests: {} total, {streamed} streamed, {rounds} rounds",
        requests.len()
    );
    rounds
}

/// A first response after the idle limit but before the total arrives and
/// is answered, with one request.
#[tokio::test]
async fn slow_first_response_within_total_is_answered() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    let first_byte = Duration::from_millis(2_500);
    let pace = Pace::FirstByteAfter(first_byte);
    let (server, s) = paced("FIRST-RESPONSE-01", pace, 6_000).await?;
    let ended = timed_turn(&s, PROMPT).await?;
    eprintln!(
        "FIRST-RESPONSE-01: {} after {:?}",
        turn_state(&ended.turn),
        ended.elapsed
    );
    assert_eq!(turn_state(&ended.turn), "delivered", "{}", ended.turn);
    assert_eq!(ended.text, ChatBehavior::default().answer);
    assert_eq!(rounds(&server), 1, "the slow round was resent");
    assert!(ended.elapsed >= first_byte, "{:?}", ended.elapsed);
    s.finish().await
}

/// Nothing by the total limit: one request, one clear failure that a
/// person can retry (which sends the request again).
#[tokio::test]
async fn no_first_response_by_total_fails_once() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    let total = Duration::from_millis(4_000);
    let pace = Pace::FirstByteAfter(Duration::from_secs(120));
    let (server, s) = paced("FIRST-RESPONSE-02", pace, 4_000).await?;
    let ended = timed_turn(&s, PROMPT).await?;
    let turn = &ended.turn;
    eprintln!(
        "FIRST-RESPONSE-02: {} after {:?}",
        turn_state(turn),
        ended.elapsed
    );
    assert_eq!(turn_state(turn), "failed", "{turn}");
    assert_eq!(turn["safe_error_code"], FIRST_RESPONSE_TIMEOUT, "{turn}");
    assert_eq!(turn["retryable"], true, "{turn}");
    assert_eq!(
        ended.text,
        "The model didn't respond within its response timeout."
    );
    assert_eq!(rounds(&server), 1, "the same request was resent");
    assert!(ended.elapsed >= total, "{:?}", ended.elapsed);
    // The App's retry for a failed provider round starts a fresh turn.
    let started = Instant::now();
    let path = format!("/turns/{}/retry-current", ended.id);
    let retry = s.gw.post(&path, json!({})).await?;
    assert_eq!(retry.status, 202, "{}", retry.text);
    let retried_id = accepted_turn_id(retry.data())?;
    let retried = s.gw.wait_terminal("general", &retried_id, WAIT).await?;
    eprintln!(
        "FIRST-RESPONSE-02 retry: {} after {:?}",
        turn_state(&retried),
        started.elapsed()
    );
    assert_eq!(
        retried["safe_error_code"], FIRST_RESPONSE_TIMEOUT,
        "{retried}"
    );
    assert_eq!(rounds(&server), 2, "one request per attempt");
    assert!(s.gw.healthy().await);
    s.finish().await
}

/// A stream that stops after its first chunk is a stall: the idle limit
/// ends it long before the total, and the round is retried as before.
#[tokio::test]
async fn stall_after_first_response_is_retried() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    // Only the idle limit can end the stalled attempt within WAIT.
    let pace = Pace::StallFirstAfterOneChunk;
    let (server, s) = paced("FIRST-RESPONSE-03", pace, 600_000).await?;
    let ended = timed_turn(&s, PROMPT).await?;
    eprintln!(
        "FIRST-RESPONSE-03: {} after {:?}",
        turn_state(&ended.turn),
        ended.elapsed
    );
    assert_eq!(turn_state(&ended.turn), "delivered", "{}", ended.turn);
    assert_eq!(ended.text, ChatBehavior::default().answer);
    assert_eq!(rounds(&server), 2, "the stalled round was not retried once");
    assert!(ended.elapsed >= Duration::from_millis(IDLE_MS));
    s.finish().await
}

/// A stream that never ends keeps resetting the idle limit; the total limit
/// stops it, and that timeout is retried up to the retry ceiling as before.
#[tokio::test]
async fn endless_stream_is_stopped_by_total() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    const CEILING: usize = 3;
    let total = Duration::from_millis(3_000);
    let pace = Pace::Endless(Duration::from_millis(200));
    let ceiling = [("BUTLER_MODEL_API_RETRY_ATTEMPTS", "3")];
    let (server, s) = paced_with("FIRST-RESPONSE-04", pace, 3_000, &ceiling).await?;
    let ended = timed_turn(&s, PROMPT).await?;
    let attempts = rounds(&server);
    eprintln!(
        "FIRST-RESPONSE-04: {} after {:?}, {attempts} attempts",
        turn_state(&ended.turn),
        ended.elapsed
    );
    assert_eq!(turn_state(&ended.turn), "failed", "{}", ended.turn);
    assert_eq!(ended.turn["safe_error_code"], "provider_round_timeout");
    assert_eq!(attempts, CEILING, "retried up to the ceiling");
    assert!(ended.elapsed >= total * 3, "{:?}", ended.elapsed);
    s.finish().await
}
