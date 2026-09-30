//! C. Streamed answer text across model rounds (SCENARIOS.md TURN-01,
//! TURN-03): the App's provisional message shows one round's text at a time,
//! and text the runtime discarded is never kept as a stopped turn's answer.
//!
//! Replays TOOL-05-symlink: one turn in which the model's first answer
//! candidate is sent back (its first write was refused and the Work was not
//! closed), and the model works on and answers again.
#![allow(
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::panic,
    reason = "test assertions"
)]

use std::time::{Duration, Instant};

use butler_e2e::e2e::HarnessError;
use butler_e2e::e2e::cassette::Cassette;
use butler_e2e::e2e::events::LiveEvents;
use butler_e2e::e2e::faults::{ArgsMutation, Fault, Transform};
use butler_e2e::e2e::gateway::turn_state;
use butler_e2e::e2e::provider::Pacing;
use butler_e2e::e2e::scenario::{Scenario, Setup, accepted_turn_id};
use serde_json::json;

const INSIDE: &str =
    "Create a file named inside.txt in your workspace containing exactly the text: hello-e2e";
const CASSETTE: &str = "TOOL-05-symlink";

/// The TOOL-05-symlink turn, with that scenario's symlink and the fault that
/// points the model's first write outside the workspace.
async fn rejected_candidate_turn(id: &str) -> Result<Scenario, HarnessError> {
    let setup = Setup::new(id)?.cassette(CASSETTE);
    butler_platform::secure_fs::symlink(&setup.sandbox.home, &setup.sandbox.data.join("link"))?;
    let s = setup.start().await?;
    s.provider()?.inject(Fault::first_call(
        "inside.txt",
        Transform::MutateToolArgs(ArgsMutation::OnlyTool {
            tool: "write_file".into(),
            mutation: Box::new(ArgsMutation::Replace {
                from: "inside.txt".into(),
                to: "link/escaped.txt".into(),
            }),
        }),
    ))?;
    Ok(s)
}

/// The answer texts of the recording, in order: the candidate that is sent
/// back, then the final one.
fn recorded_answers() -> Result<Vec<String>, HarnessError> {
    let answers: Vec<String> = Cassette::load(CASSETTE)?
        .exchanges
        .iter()
        .map(|exchange| exchange.response.output_text())
        .filter(|text| !text.is_empty())
        .collect();
    assert_eq!(answers.len(), 2, "{answers:?}");
    Ok(answers)
}

/// TURN-01 (rounds) — the provisional message shows one stream at a time: the
/// next round's text replaces a candidate that was sent back instead of being
/// appended to it.
#[tokio::test]
async fn turn_01_next_round_replaces_a_rejected_candidates_text() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    let answers = recorded_answers()?;
    let s = rejected_candidate_turn("TURN-01-ROUNDS").await?;
    let live = LiveEvents::subscribe(&s.gw, 0).await?;
    let (turn_id, turn) = s.turn("general", INSIDE).await?;
    assert_eq!(turn_state(&turn), "delivered", "{turn}");
    let streamed: Vec<String> = live
        .snapshot()
        .iter()
        .map(|event| &event["payload"]["message"])
        .filter(|message| {
            message["turn_id"] == turn_id.as_str() && message["status"] == "streaming"
        })
        .map(|message| message["text"].as_str().unwrap_or_default().to_owned())
        .collect();
    for text in &streamed {
        assert!(
            answers
                .iter()
                .any(|answer| answer.starts_with(text.as_str())),
            "streamed text mixes rounds: {text:?}"
        );
    }
    assert!(
        streamed.iter().any(|text| answers[0] == *text),
        "the first candidate was not streamed: {streamed:?}"
    );
    assert_eq!(
        streamed.last(),
        Some(&answers[1]),
        "the final round did not replace the candidate: {streamed:?}"
    );
    s.finish().await
}

/// TURN-03 (discarded text) — Stop after the model's candidate was sent back
/// keeps no partial answer: that text is not an answer.
#[tokio::test]
async fn turn_03_stop_after_a_rejected_candidate_keeps_no_partial() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    let answers = recorded_answers()?;
    let s = rejected_candidate_turn("TURN-03-DISCARDED").await?;
    s.provider()?.set_pacing(Pacing {
        scale: 1.0,
        cap_ms: 300,
        min_ms: 150,
    });
    let accepted = s.gw.say("general", INSIDE).await?;
    let turn_id = accepted_turn_id(&accepted)?;
    // The ninth request follows the sent-back candidate (the eighth answer).
    let deadline = Instant::now() + Duration::from_secs(90);
    while s.provider()?.served() < 9 {
        assert!(Instant::now() < deadline, "candidate round never reached");
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
    let cancel =
        s.gw.post(&format!("/turns/{turn_id}/cancel"), json!({}))
            .await?;
    assert_eq!(cancel.status, 202, "{}", cancel.text);
    let turn =
        s.gw.wait_terminal("general", &turn_id, Duration::from_secs(20))
            .await?;
    assert_eq!(turn_state(&turn), "cancelled", "{turn}");
    let kept: Vec<_> = s
        .gw
        .messages("general")
        .await?
        .into_iter()
        .filter(|message| message["role"] == "assistant" && message["turn_id"] == turn_id.as_str())
        .collect();
    assert!(
        kept.iter().all(|message| {
            let text = message["text"].as_str().unwrap_or_default();
            text.is_empty() || !answers[0].starts_with(text)
        }),
        "the sent-back candidate was kept as the answer: {kept:?}"
    );
    s.finish().await
}
