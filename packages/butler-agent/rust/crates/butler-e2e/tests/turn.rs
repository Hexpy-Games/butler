//! C. Conversation turn (SCENARIOS.md TURN-01, 02, 03, 07; TURN-05 in turn_faults.rs).
//!
//! Fault scenarios record clean traffic (record mode ignores faults) and
//! inject the failure only at replay.
#![allow(
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::panic,
    reason = "test assertions"
)]

use std::time::{Duration, Instant};

use butler_e2e::e2e::HarnessError;
use butler_e2e::e2e::events::{LiveEvents, event_turn_id};
use butler_e2e::e2e::gateway::{TERMINAL, turn_state};
use butler_e2e::e2e::provider::Pacing;
use butler_e2e::e2e::scenario::{Scenario, Setup, accepted_turn_id};
use serde_json::{Value, json};

const NUMBERS: &str = "Write the numbers from one to twelve as English words, separated by single spaces, and nothing else.";

fn state_rank(state: &str) -> u8 {
    match state {
        "queued" => 0,
        "accepted" => 1,
        "thinking" | "streaming" | "waiting_for_tool" | "waiting_for_form" | "retrying" => 2,
        "cancelling" => 3,
        _ => 4,
    }
}

/// `turn.state_changed` states for one turn, in event order.
fn turn_states(events: &[Value], turn_id: &str) -> Vec<String> {
    events
        .iter()
        .filter(|event| {
            event["type"] == "turn.state_changed" && event_turn_id(event) == Some(turn_id)
        })
        .map(|event| {
            event["payload"]["turn"]["state"]
                .as_str()
                .unwrap_or_default()
                .to_owned()
        })
        .collect()
}

fn by_role<'a>(messages: &'a [Value], role: &str) -> Vec<&'a Value> {
    messages
        .iter()
        .filter(|message| message["role"] == role)
        .collect()
}

async fn new_session(s: &Scenario, title: &str) -> Result<String, HarnessError> {
    let reply =
        s.gw.post("/sessions", json!({"kind": "chat", "title": title}))
            .await?;
    assert_eq!(reply.status, 201, "{}", reply.text);
    Ok(reply.data()["session"]["id"]
        .as_str()
        .unwrap_or_default()
        .to_owned())
}

/// TURN-01 — Reply is delivered, persisted and survives restart.
#[tokio::test]
async fn turn_01_reply_is_delivered_persisted_and_survives_restart() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    let mut s = Setup::new("TURN-01")?.cassette("TURN-01").start().await?;
    let live = LiveEvents::subscribe(&s.gw, 0).await?;
    let client_id = uuid::Uuid::new_v4().to_string();
    let reply =
        s.gw.post(
            "/messages",
            json!({"chat_id": "general", "text": NUMBERS, "client_message_id": client_id}),
        )
        .await?;
    assert_eq!(reply.status, 202, "{}", reply.text);
    let turn_id = accepted_turn_id(reply.data())?;
    assert!(reply.data()["accepted"]["id"].is_string());
    let turn =
        s.gw.wait_terminal("general", &turn_id, Duration::from_secs(60))
            .await?;
    assert_eq!(turn_state(&turn), "delivered", "{turn}");

    let created = live
        .wait_for(Duration::from_secs(10), |event| {
            event["type"] == "message.created" && event["payload"]["message"]["role"] == "assistant"
        })
        .await?;
    tokio::time::sleep(Duration::from_millis(300)).await;
    let events = live.snapshot();
    let states = turn_states(&events, &turn_id);
    assert_eq!(
        states.last().map(String::as_str),
        Some("delivered"),
        "{states:?}"
    );
    let ranks: Vec<u8> = states.iter().map(|state| state_rank(state)).collect();
    assert!(
        ranks.windows(2).all(|pair| pair[0] <= pair[1]),
        "non-monotonic states {states:?}"
    );
    assert_eq!(
        states
            .iter()
            .filter(|state| TERMINAL.contains(&state.as_str()))
            .count(),
        1,
        "{states:?}"
    );

    let messages = s.gw.messages("general").await?;
    let users = by_role(&messages, "user");
    let assistants = by_role(&messages, "assistant");
    assert_eq!(users.len(), 1);
    assert_eq!(assistants.len(), 1);
    assert_eq!(users[0]["text"], NUMBERS);
    let answer = assistants[0]["text"]
        .as_str()
        .unwrap_or_default()
        .to_owned();
    assert!(!answer.trim().is_empty());
    assert_eq!(
        created["payload"]["message"]["text"],
        answer.as_str(),
        "live text != persisted text"
    );
    for message in &messages {
        assert!(
            message["created_at"]
                .as_str()
                .is_some_and(|at| at.ends_with('Z')),
            "{message}"
        );
    }

    s.restart().await?;
    let after = s.gw.messages("general").await?;
    let texts = |list: &[Value]| {
        list.iter()
            .map(|m| (m["id"].clone(), m["text"].clone(), m["created_at"].clone()))
            .collect::<Vec<_>>()
    };
    assert_eq!(
        texts(&after),
        texts(&messages),
        "messages changed across restart"
    );
    let export = s.gw.get("/transcript-export?session_id=general").await?;
    assert_eq!(export.status, 200, "{}", export.text);
    assert!(
        export.text.contains("one to twelve"),
        "export lacks the user message"
    );
    let answer_head: String = answer.chars().take(20).collect();
    assert!(
        export.text.contains(&answer_head),
        "export lacks the assistant message"
    );
    s.finish().await
}

/// TURN-01 (streaming part) — the UI receives incremental text.
#[tokio::test]
#[ignore = "product gap: TURN-01-STREAM — the Rust runtime emits no model.stream.text_delta / message.final.delta events; the UI gets the answer only as one message.created"]
async fn turn_01_reply_is_streamed_incrementally() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    let s = Setup::new("TURN-01-STREAM")?
        .cassette("TURN-01")
        .replay_only()
        .start()
        .await?;
    let live = LiveEvents::subscribe(&s.gw, 0).await?;
    let (_, turn) = s.turn("general", NUMBERS).await?;
    assert_eq!(turn_state(&turn), "delivered");
    let deltas = live
        .snapshot()
        .iter()
        .filter(|event| {
            matches!(
                butler_e2e::e2e::events::turn_event_kind(event),
                Some("model.stream.text_delta" | "message.final.delta")
            )
        })
        .count();
    assert!(deltas > 1, "expected streamed text deltas, saw {deltas}");
    s.finish().await
}

/// TURN-02 — Duplicate submit is idempotent.
#[tokio::test]
async fn turn_02_duplicate_submit_is_idempotent() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    let s = Setup::new("TURN-02")?.cassette("TURN-02").start().await?;
    let client_id = uuid::Uuid::new_v4().to_string();
    let body = json!({"chat_id": "general", "text": "Reply with exactly the word: once", "client_message_id": client_id});
    let (first, second) = tokio::join!(
        s.gw.post("/messages", body.clone()),
        s.gw.post("/messages", body.clone())
    );
    let (first, second) = (first?, second?);
    assert!(
        first.status < 300 && second.status < 300,
        "{} / {}",
        first.text,
        second.text
    );
    // One of the two may answer with the queued entry; the turn is found via /turns.
    let deadline = Instant::now() + Duration::from_secs(20);
    let turn_id = loop {
        if let Some(turn) = s.gw.turns("general").await?.first() {
            break butler_e2e::e2e::gateway::turn_id_of(turn)
                .unwrap_or_default()
                .to_owned();
        }
        assert!(Instant::now() < deadline, "no turn created");
        tokio::time::sleep(Duration::from_millis(50)).await;
    };
    s.gw.wait_terminal("general", &turn_id, Duration::from_secs(60))
        .await?;
    let third = s.gw.post("/messages", body.clone()).await?;
    assert!(third.status < 300, "{}", third.text);

    let changed =
        s.gw.post(
            "/messages",
            json!({"chat_id": "general", "text": "different text", "client_message_id": client_id}),
        )
        .await?;
    assert!(
        (400..500).contains(&changed.status),
        "changed body: {} {}",
        changed.status,
        changed.text
    );

    tokio::time::sleep(Duration::from_millis(500)).await;
    let messages = s.gw.messages("general").await?;
    assert_eq!(by_role(&messages, "user").len(), 1, "{messages:?}");
    assert_eq!(by_role(&messages, "assistant").len(), 1, "{messages:?}");
    assert_eq!(s.gw.turns("general").await?.len(), 1);
    s.finish().await
}

/// TURN-03 — Stop mid-stream (owner: keep partial text, mark the turn stopped).
#[tokio::test]
async fn turn_03_stop_mid_stream() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    let mut s = Setup::new("TURN-03")?.cassette("TURN-03").start().await?;
    if s.recording() {
        s.turn("general", NUMBERS).await?;
        s.turn("general", "Reply with exactly the word: after-stop")
            .await?;
        return s.finish().await;
    }
    // Slow the recorded stream so Stop lands while it is being received.
    s.provider()?.set_pacing(Pacing {
        scale: 1.0,
        cap_ms: 400,
        min_ms: 250,
    });
    let live = LiveEvents::subscribe(&s.gw, 0).await?;
    let accepted = s.gw.say("general", NUMBERS).await?;
    let turn_id = accepted_turn_id(&accepted)?;
    let deadline = Instant::now() + Duration::from_secs(20);
    while s.provider()?.served() == 0 {
        assert!(Instant::now() < deadline, "provider never called");
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
    tokio::time::sleep(Duration::from_millis(600)).await;
    let cancel =
        s.gw.post(&format!("/turns/{turn_id}/cancel"), json!({}))
            .await?;
    assert_eq!(cancel.status, 202, "{}", cancel.text);
    let stopped_at = Instant::now();
    let turn =
        s.gw.wait_terminal("general", &turn_id, Duration::from_secs(15))
            .await?;
    assert_eq!(turn_state(&turn), "cancelled", "{turn}");
    assert!(stopped_at.elapsed() < Duration::from_secs(10));

    tokio::time::sleep(Duration::from_millis(1500)).await;
    let events = live.snapshot();
    let states = turn_states(&events, &turn_id);
    assert!(
        !states.iter().any(|state| state == "delivered"),
        "{states:?}"
    );
    let cancelled_at = events
        .iter()
        .position(|event| {
            event["type"] == "turn.state_changed"
                && event["payload"]["turn"]["state"] == "cancelled"
        })
        .unwrap_or(usize::MAX);
    let late: Vec<&Value> = events
        .iter()
        .skip(cancelled_at.saturating_add(1))
        .filter(|event| {
            event_turn_id(event) == Some(turn_id.as_str())
                && (event["type"] == "turn.state_changed" || event["type"] == "message.created")
        })
        .collect();
    assert!(late.is_empty(), "turn activity after cancelled: {late:?}");
    let messages = s.gw.messages("general").await?;
    for message in by_role(&messages, "assistant") {
        if message["turn_id"] == turn_id.as_str() {
            assert_ne!(
                message["status"], "delivered",
                "partial text shown as a completed answer: {message}"
            );
        }
    }

    let (_, next) = s
        .turn("general", "Reply with exactly the word: after-stop")
        .await?;
    assert_eq!(turn_state(&next), "delivered", "{next}");
    s.restart().await?;
    let turn = s.gw.turn("general", &turn_id).await?.unwrap_or_default();
    assert_eq!(turn_state(&turn), "cancelled", "{turn}");
    s.finish().await
}

/// TURN-03 (partial text) — owner decision: keep the partial text, marked stopped.
#[tokio::test]
#[ignore = "product gap: TURN-03-PARTIAL — after Stop mid-stream no partial assistant text is kept; the owner decided partial text stays, marked stopped"]
async fn turn_03_stop_keeps_partial_text_marked_stopped() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    let s = Setup::new("TURN-03-PARTIAL")?
        .cassette("TURN-03")
        .replay_only()
        .start()
        .await?;
    s.provider()?.set_pacing(Pacing {
        scale: 1.0,
        cap_ms: 400,
        min_ms: 250,
    });
    let accepted = s.gw.say("general", NUMBERS).await?;
    let turn_id = accepted_turn_id(&accepted)?;
    while s.provider()?.served() == 0 {
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
    tokio::time::sleep(Duration::from_millis(1500)).await;
    s.gw.post(&format!("/turns/{turn_id}/cancel"), json!({}))
        .await?;
    s.gw.wait_terminal("general", &turn_id, Duration::from_secs(15))
        .await?;
    let messages = s.gw.messages("general").await?;
    let partial = messages
        .iter()
        .find(|message| message["role"] == "assistant" && message["turn_id"] == turn_id.as_str());
    let partial = partial.expect("partial assistant text kept after Stop");
    assert!(!partial["text"].as_str().unwrap_or_default().is_empty());
    assert_ne!(partial["status"], "delivered");
    s.finish().await
}

/// TURN-07 — Parallel sessions stay isolated.
#[tokio::test]
async fn turn_07_parallel_sessions_stay_isolated() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    let s = Setup::new("TURN-07")?.cassette("TURN-07").start().await?;
    let words = ["alpha", "bravo", "charlie"];
    let mut sessions = Vec::new();
    for word in words {
        sessions.push((new_session(&s, word).await?, word));
    }
    let live = LiveEvents::subscribe(&s.gw, 0).await?;
    let mut tasks = Vec::new();
    for (session, word) in &sessions {
        let gw = s.gw.clone();
        let (session, prompt) = (
            session.clone(),
            format!("Reply with exactly the word: {word}"),
        );
        tasks.push(tokio::spawn(async move {
            let accepted = gw.say(&session, &prompt).await?;
            let turn_id = accepted_turn_id(&accepted)?;
            gw.wait_terminal(&session, &turn_id, Duration::from_secs(120))
                .await
                .map(|turn| (turn_id, turn))
        }));
    }
    let mut turn_ids = Vec::new();
    for task in tasks {
        let (turn_id, turn) = task
            .await
            .map_err(|error| butler_e2e::e2e::harness_error(error.to_string()))??;
        assert_eq!(turn_state(&turn), "delivered", "{turn}");
        turn_ids.push(turn_id);
    }
    for (index, (session, word)) in sessions.iter().enumerate() {
        let messages = s.gw.messages(session).await?;
        assert_eq!(messages.len(), 2, "{session}: {messages:?}");
        for message in &messages {
            assert_eq!(message["chat_id"], session.as_str());
            assert_eq!(message["turn_id"], turn_ids[index].as_str());
        }
        let answer = by_role(&messages, "assistant")[0]["text"]
            .as_str()
            .unwrap_or_default()
            .to_lowercase();
        assert!(answer.contains(word), "{session} got {answer}");
        for other in words.iter().filter(|other| *other != word) {
            assert!(!answer.contains(other), "{session} leaked {other}");
        }
    }
    for event in live.snapshot() {
        if event["type"] == "message.created" {
            let message = &event["payload"]["message"];
            if let Some(index) = turn_ids
                .iter()
                .position(|id| message["turn_id"] == id.as_str())
            {
                assert_eq!(
                    message["chat_id"],
                    sessions[index].0.as_str(),
                    "event for wrong session: {event}"
                );
            }
        }
    }
    s.finish().await
}
