//! C. Conversation turn — broken provider streams (SCENARIOS.md TURN-05).
//!
//! Records clean traffic (record mode ignores these faults) and injects the
//! failure only at replay.
#![allow(
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::panic,
    reason = "test assertions"
)]

use std::time::{Duration, Instant};

use butler_e2e::e2e::HarnessError;
use butler_e2e::e2e::faults::{Fault, Transform};
use butler_e2e::e2e::gateway::{Gateway, turn_state};
use butler_e2e::e2e::scenario::Setup;
use serde_json::{Value, json};

/// TURN-05 — Broken stream: truncation, reset, stall.
///
/// A cut or reset stream is retried once and delivered. The stall is
/// injected after three lifecycle events (`response.created`,
/// `response.in_progress`, `response.output_item.added`) and before any
/// output, so it is a first-response timeout: one request, no resend, a
/// retryable failure. A stall after real output (retried by the idle limit)
/// is covered by FIRST-RESPONSE-03 in `provider_first_response.rs`.
#[tokio::test]
async fn turn_05_broken_stream_never_delivers_partial_text() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    let s = Setup::new("TURN-05")?
        .cassette("TURN-05")
        .env("BUTLER_MODEL_API_RETRY_DELAY_MS", "50")
        // The product applies no idle timeout to OpenAI rounds (long silent
        // reasoning is normal); the stall is bounded by the round timeout.
        .env("BUTLER_PROVIDER_ROUND_IDLE_TIMEOUT_MS", "3000")
        .env(
            "BUTLER_PROVIDER_ROUND_TIMEOUT_MS",
            if butler_e2e::e2e::config::flag("BUTLER_E2E_RECORD") {
                "300000"
            } else {
                "8000"
            },
        )
        .start()
        .await?;
    let prompts = [
        (
            "truncate",
            "Reply with exactly the words: broken stream one",
        ),
        ("reset", "Reply with exactly the words: broken stream two"),
        ("stall", "Reply with exactly the words: broken stream three"),
    ];
    if s.recording() {
        for (_, prompt) in prompts {
            s.turn("general", prompt).await?;
        }
        return s.finish().await;
    }
    let bystander =
        s.gw.post("/sessions", json!({"kind": "chat", "title": "bystander"}))
            .await?;
    let other = bystander.data()["session"]["id"]
        .as_str()
        .unwrap_or_default()
        .to_owned();
    for (kind, prompt) in &prompts {
        let transform = match *kind {
            "truncate" => Transform::TruncateAfter(4),
            "reset" => Transform::ResetAfter(4),
            _ => Transform::StallAfter(3),
        };
        let exchange = s.provider()?.exchange_for(prompt, 0)?;
        s.provider()?.inject(Fault::once(exchange, transform))?;
        let started = Instant::now();
        let before = rounds_for(&s.provider()?.requests(), prompt);
        eprintln!("TURN-05 injecting {kind}");
        let (turn_id, turn) = s.turn("general", prompt).await?;
        let sent = rounds_for(&s.provider()?.requests(), prompt) - before;
        eprintln!(
            "TURN-05 {kind}: {} after {:?}, {sent} requests",
            turn_state(&turn),
            started.elapsed()
        );
        let state = turn_state(&turn).to_owned();
        if *kind == "stall" {
            assert_eq!(state, "failed", "{kind}: {turn}");
            assert_eq!(
                turn["safe_error_code"], "provider_first_response_timeout",
                "{turn}"
            );
            assert_eq!(turn["retryable"], true, "{turn}");
            assert_eq!(sent, 1, "the stalled request was resent");
            butler_e2e::assert_wall_clock_budget!(
                started.elapsed(),
                Duration::from_secs(40),
                "stall not bounded"
            );
        } else {
            assert_eq!(state, "delivered", "{kind}: {turn}");
            assert_eq!(sent, 2, "{kind}: one failed request and one retry");
        }
        assert_no_partial_answer(&s.gw, kind, &turn_id, &state).await?;
        assert!(s.gw.healthy().await);
        let bystander = s.gw.get(&format!("/messages?chat_id={other}")).await?;
        assert_eq!(bystander.status, 200);
    }
    s.finish().await
}

/// Turn-round requests carrying `prompt` (session titles quote the prompt
/// too, and are not rounds).
fn rounds_for(requests: &[Value], prompt: &str) -> usize {
    requests
        .iter()
        .filter(|r| !butler_e2e::e2e::provider::is_title_request(r))
        .filter(|r| r.to_string().contains(prompt))
        .count()
}

/// A turn that ended `state` after a `kind` fault persisted no half answer
/// as final; a delivered (retried) turn has exactly one complete answer.
async fn assert_no_partial_answer(
    gw: &Gateway,
    kind: &str,
    turn_id: &str,
    state: &str,
) -> Result<(), HarnessError> {
    let messages = gw.messages("general").await?;
    let answers: Vec<&Value> = messages
        .iter()
        .filter(|message| message["role"] == "assistant" && message["turn_id"] == turn_id)
        .collect();
    if state == "delivered" {
        // Retried after the injected failure: exactly one complete answer.
        assert_eq!(answers.len(), 1, "{kind}: {answers:?}");
    } else {
        assert!(
            answers
                .iter()
                .all(|message| message["status"] != "delivered"),
            "{kind}: half answer persisted as final: {answers:?}"
        );
    }
    Ok(())
}
