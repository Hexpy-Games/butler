//! N. Stop pauses the session queue (SCENARIOS.md Q-02, owner decision): the
//! messages queued behind the stopped turn wait, the session-queue view says
//! so, and the next user input resumes the queue in order.
#![allow(
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::panic,
    reason = "test assertions"
)]

use std::time::{Duration, Instant};

use butler_e2e::e2e::HarnessError;
use butler_e2e::e2e::gateway::{TERMINAL, turn_state};
use butler_e2e::e2e::provider::Pacing;
use butler_e2e::e2e::scenario::{Scenario, Setup, accepted_turn_id};
use serde_json::{Value, json};

const LONG: &str = "Write the numbers from one to twelve as English words, separated by single spaces, and nothing else.";
const PAUSED: &str = "Reply with exactly the word: paused";
const RESUMED: &str = "Reply with exactly the word: resumed";

async fn queue_view(s: &Scenario) -> Result<Value, HarnessError> {
    let reply = s.gw.get("/session-queue?chat_id=general").await?;
    assert_eq!(reply.status, 200, "{}", reply.text);
    Ok(reply.data().clone())
}

/// Sends `text` to the general chat (queued or dispatched, as the product
/// decides).
async fn send(s: &Scenario, path: &str, text: &str) -> Result<(), HarnessError> {
    let reply =
        s.gw.post(
            path,
            json!({"chat_id": "general", "text": text,
                "client_message_id": uuid::Uuid::new_v4().to_string()}),
        )
        .await?;
    assert!(
        reply.status < 300,
        "{path}: {} {}",
        reply.status,
        reply.text
    );
    Ok(())
}

/// Starts the slow turn and stops it with `PAUSED` queued behind it.
async fn stop_with_a_queued_message(s: &Scenario) -> Result<(), HarnessError> {
    s.provider()?.set_pacing(Pacing {
        scale: 1.0,
        cap_ms: 300,
        min_ms: 200,
    });
    let running = accepted_turn_id(&s.gw.say("general", LONG).await?)?;
    let deadline = Instant::now() + Duration::from_secs(20);
    while s.provider()?.served() == 0 {
        assert!(Instant::now() < deadline, "provider not reached");
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
    send(s, "/session-queue", PAUSED).await?;
    let cancel =
        s.gw.post(&format!("/turns/{running}/cancel"), json!({}))
            .await?;
    assert_eq!(cancel.status, 202, "{}", cancel.text);
    let turn =
        s.gw.wait_terminal("general", &running, Duration::from_secs(20))
            .await?;
    assert_eq!(turn_state(&turn), "cancelled", "{turn}");
    Ok(())
}

/// Q-02 (owner decision) — Stop pauses the queue until the next user input,
/// which resumes it in order: the message queued before the Stop runs first,
/// then the new one.
#[tokio::test]
async fn q_02_cancel_pauses_the_queue_until_the_next_input() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    let s = Setup::new("Q-02-CANCEL")?
        .cassette("Q-02-CANCEL")
        .start()
        .await?;
    if s.recording() {
        // Clean traffic for the three rounds the replay serves.
        for text in [LONG, PAUSED, RESUMED] {
            s.turn("general", text).await?;
        }
        return s.finish().await;
    }
    stop_with_a_queued_message(&s).await?;
    tokio::time::sleep(Duration::from_secs(3)).await;
    let view = queue_view(&s).await?;
    assert_eq!(view["paused"], true, "{view}");
    assert_eq!(view["queued_messages"].as_array().map(Vec::len), Some(1));
    assert_eq!(s.gw.turns("general").await?.len(), 1, "queue continued");

    send(&s, "/messages", RESUMED).await?;
    let deadline = Instant::now() + Duration::from_secs(120);
    loop {
        let turns = s.gw.turns("general").await?;
        let settled = turns
            .iter()
            .all(|turn| TERMINAL.contains(&turn_state(turn)));
        if turns.len() == 3 && settled {
            break;
        }
        assert!(Instant::now() < deadline, "queue did not resume: {turns:?}");
        tokio::time::sleep(Duration::from_millis(200)).await;
    }
    let messages = s.gw.messages("general").await?;
    let texts = |role: &str| -> Vec<String> {
        messages
            .iter()
            .filter(|message| message["role"] == role)
            .map(|message| message["text"].as_str().unwrap_or_default().to_lowercase())
            .collect()
    };
    let asked = texts("user");
    assert_eq!(
        asked,
        [LONG, PAUSED, RESUMED].map(str::to_lowercase),
        "not resumed in order"
    );
    let answers = texts("assistant");
    let position = |word: &str| answers.iter().position(|text| text.contains(word));
    assert!(
        matches!((position("paused"), position("resumed")), (Some(first), Some(second)) if first < second),
        "{answers:?}"
    );
    let view = queue_view(&s).await?;
    assert_eq!(view["paused"], false, "{view}");
    assert_eq!(view["queued_messages"].as_array().map(Vec::len), Some(0));
    s.finish().await
}
