//! Shutdown preserves an App admission between durable Turn creation and enqueue.
#![allow(
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::panic,
    reason = "test assertions"
)]

use butler_e2e::e2e::{
    HarnessError,
    gateway::turn_state,
    provider::Pacing,
    scenario::{Setup, accepted_turn_id},
};
use butler_platform::sqlite;
use serde_json::json;
use std::time::{Duration, Instant};

const LONG: &str = "Write the numbers from one to twelve as English words, separated by single spaces, and nothing else.";
const HELD_MESSAGE: &str = "client-00000000-0000-4000-8000-000000000002";
const WAITING: &str = "Reply with exactly the word: waiting";

#[tokio::test]
async fn q_02_shutdown_finishes_an_in_flight_queue_admission() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    let mut s = Setup::new("Q-02-ADMISSION-SHUTDOWN")?
        .cassette("Q-02")
        .env("BUTLER_E2E_TIER", "stub")
        .env("BUTLER_E2E_HOLD_QUEUE_MESSAGE", HELD_MESSAGE)
        .start()
        .await?;
    s.provider()?.set_pacing(Pacing {
        scale: 1.0,
        cap_ms: 300,
        min_ms: 200,
    });
    let first = accepted_turn_id(&s.gw.say("general", LONG).await?)?;
    let queued =
        s.gw.post(
            "/session-queue",
            json!({"chat_id":"general", "text":WAITING,
        "client_message_id":HELD_MESSAGE}),
        )
        .await?;
    assert_eq!(queued.status, 202, "{}", queued.text);
    s.gw.wait_terminal("general", &first, Duration::from_secs(10))
        .await?;
    let held = s.sandbox.data.join("e2e-queue-admission-held");
    let deadline = Instant::now() + Duration::from_secs(10);
    while !held.exists() {
        assert!(
            Instant::now() < deadline,
            "queue admission never reached barrier"
        );
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
    let turns = s.gw.turns("general").await?;
    assert_eq!(turns.len(), 2, "barrier must follow durable Turn creation");
    let held_turn = turns
        .iter()
        .find(|turn| turn["user_message_id"] == HELD_MESSAGE)
        .unwrap();
    assert_eq!(turn_state(held_turn), "thinking");
    let held_turn_id = held_turn["id"].as_str().unwrap().to_owned();
    s.agent.terminate().await?;
    let db = sqlite::open(s.sandbox.data.join("app-server/butler-client.sqlite")).unwrap();
    let pending: (String, Option<String>, Option<String>) = db
        .query_row(
            "SELECT state,safe_error_code,turn_id FROM session_queued_messages WHERE text=?1",
            [WAITING],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
        )
        .unwrap();
    assert_eq!(
        pending.0, "queued",
        "shutdown must release in-flight admission"
    );
    assert!(pending.1.is_none());
    assert_eq!(pending.2.as_deref(), Some(held_turn_id.as_str()));
    drop(db);
    s.agent.launch.set_env("BUTLER_E2E_HOLD_QUEUE_MESSAGE", "");
    s.gw = s.agent.start_again().await?;
    let deadline = Instant::now() + Duration::from_secs(10);
    loop {
        let turns = s.gw.turns("general").await?;
        if turns.len() == 2 && turns.iter().all(|turn| turn_state(turn) == "delivered") {
            assert!(turns.iter().any(|turn| turn["id"] == held_turn_id));
            break;
        }
        assert!(
            Instant::now() < deadline,
            "queue admission stranded after restart: {turns:?}"
        );
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
    let view = s.gw.get("/session-queue?chat_id=general").await?;
    assert_eq!(view.data()["paused"], false);
    assert!(
        view.data()["queued_messages"]
            .as_array()
            .unwrap()
            .is_empty()
    );
    let messages = s.gw.messages("general").await?;
    assert_eq!(messages.iter().filter(|m| m["role"] == "user").count(), 2);
    assert_eq!(
        messages
            .iter()
            .filter(|m| m["role"] == "assistant" && m["text"] == "waiting")
            .count(),
        1
    );
    assert_eq!(s.provider()?.served(), 2);
    s.finish().await
}
