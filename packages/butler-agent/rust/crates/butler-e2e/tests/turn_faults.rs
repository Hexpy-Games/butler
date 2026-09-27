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
use butler_e2e::e2e::gateway::turn_state;
use butler_e2e::e2e::scenario::Setup;
use serde_json::{Value, json};

/// TURN-05 — Broken stream: truncation, reset, stall.
#[tokio::test]
async fn turn_05_broken_stream_never_delivers_partial_text() -> Result<(), HarnessError> {
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
        eprintln!("TURN-05 injecting {kind}");
        let (turn_id, turn) = s.turn("general", prompt).await?;
        eprintln!(
            "TURN-05 {kind}: {} after {:?}",
            turn_state(&turn),
            started.elapsed()
        );
        let state = turn_state(&turn).to_owned();
        assert!(
            matches!(state.as_str(), "failed" | "delivered"),
            "{kind}: {turn}"
        );
        if *kind == "stall" {
            assert!(
                started.elapsed() < Duration::from_secs(40),
                "stall not bounded: {:?}",
                started.elapsed()
            );
        }
        let messages = s.gw.messages("general").await?;
        let answers: Vec<&Value> = messages
            .iter()
            .filter(|message| {
                message["role"] == "assistant" && message["turn_id"] == turn_id.as_str()
            })
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
        assert!(s.gw.healthy().await);
        let bystander = s.gw.get(&format!("/messages?chat_id={other}")).await?;
        assert_eq!(bystander.status, 200);
    }
    s.finish().await
}
