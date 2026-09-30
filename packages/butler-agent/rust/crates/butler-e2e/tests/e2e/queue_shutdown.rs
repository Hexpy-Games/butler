//! Q-02 regression: shutdown interrupts active work without pausing queued input.
#![allow(
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::panic,
    reason = "test assertions"
)]

use butler_e2e::e2e::{
    HarnessError,
    cassette::{Cassette, Chunk},
    gateway::{TERMINAL, turn_state},
    provider::Pacing,
    scenario::{Scenario, Setup, accepted_turn_id},
};
use serde_json::json;
use std::time::{Duration, Instant};

async fn active_stream() -> Result<(Scenario, String), HarnessError> {
    let mut cassette = Cassette::load("Q-02")?;
    let prompt = cassette.exchanges[0].request.key.user_request.clone();
    let body = cassette.exchanges[0].response.body();
    cassette.exchanges[0].response.chunks = body
        .split("\n\n")
        .filter(|text| !text.is_empty())
        .enumerate()
        .map(|(index, text)| Chunk {
            // The first delta is visible before the rest of the stream stalls.
            delay_ms: if index < 5 { 0 } else { 30_000 },
            text: format!("{text}\n\n"),
        })
        .collect();
    let s = Setup::new("Q-02-SHUTDOWN")?
        .stub_cassette(cassette)
        .start()
        .await?;
    s.provider()?.set_pacing(Pacing {
        scale: 1.0,
        cap_ms: 30_000,
        min_ms: 0,
    });
    let running = accepted_turn_id(&s.gw.say("general", &prompt).await?)?;
    let deadline = Instant::now() + Duration::from_secs(10);
    loop {
        let messages = s.gw.messages("general").await?;
        if messages.iter().any(|m| {
            m["turn_id"] == running
                && m["role"] == "assistant"
                && m["text"]
                    .as_str()
                    .is_some_and(|text| text.starts_with("one"))
        }) {
            break;
        }
        assert!(Instant::now() < deadline, "stream never became active");
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
    Ok((s, running))
}

#[tokio::test]
async fn q_02_shutdown_interrupts_active_turn_and_resumes_queue() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    let (mut s, running) = active_stream().await?;
    let queued =
        s.gw.post(
            "/session-queue",
            json!({
                "chat_id":"general", "text":"Reply with exactly the word: waiting",
                "client_message_id":uuid::Uuid::new_v4().to_string()
            }),
        )
        .await?;
    assert_eq!(queued.status, 202, "{}", queued.text);
    assert!(!TERMINAL.contains(&turn_state(&s.gw.turn("general", &running).await?.unwrap())));
    let started = Instant::now();
    s.agent.launch.set_env("BUTLER_E2E_TIER", "stub");
    s.agent
        .launch
        .set_env("BUTLER_E2E_HOLD_DISPATCH_READY", "1");
    s.restart().await?;
    let held = s.sandbox.data.join("e2e-dispatch-ready-held");
    let deadline = Instant::now() + Duration::from_secs(10);
    while !held.exists() {
        assert!(s.agent.is_running(), "{}", s.agent.logs());
        assert!(
            Instant::now() < deadline,
            "inbound poll did not reach barrier"
        );
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
    let readiness = s.gw.get("/runtime-readiness").await?;
    assert_eq!(readiness.data()["btcc_executor_ready"], false);
    // Recovered waiting input must remain queued until the native poll loop is
    // ready. Hold that existing startup barrier while the App owners run.
    let observation = Instant::now() + Duration::from_secs(1);
    loop {
        let view = s.gw.get("/session-queue?chat_id=general").await?;
        let waiting = view.data()["queued_messages"]
            .as_array()
            .unwrap()
            .iter()
            .find(|item| item["text"] == "Reply with exactly the word: waiting")
            .unwrap();
        assert_eq!(waiting["state"], "queued", "{waiting}");
        assert_eq!(s.provider()?.served(), 1);
        if Instant::now() >= observation {
            break;
        }
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
    tokio::fs::write(
        s.sandbox.data.join("e2e-dispatch-ready-release"),
        b"release",
    )
    .await?;
    let deadline = Instant::now() + Duration::from_secs(10);
    loop {
        let view = s.gw.get("/session-queue?chat_id=general").await?;
        let turns = s.gw.turns("general").await?;
        let completed = turns
            .iter()
            .filter(|turn| turn_state(turn) == "delivered")
            .count();
        let items = view.data()["queued_messages"].as_array().unwrap();
        // Interrupted input remains failed and retryable in the queue view.
        // Drained means no waiting input, rather than no visible records.
        if completed == 1 && items.iter().all(|item| item["state"] != "queued") {
            assert_eq!(items.len(), 1, "{items:?}");
            assert_eq!(items[0]["turn_id"], running);
            assert_eq!(items[0]["state"], "failed");
            assert_eq!(items[0]["safe_error_code"], "turn_interrupted");
            assert_eq!(view.data()["paused"], false, "{}", view.text);
            assert_eq!(turns.len(), 2, "{turns:?}");
            break;
        }
        assert!(
            Instant::now() < deadline,
            "queue stuck after restart: queue={} turns={turns:?}",
            view.text
        );
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
    let interrupted = s.gw.turn("general", &running).await?.unwrap();
    assert_eq!(turn_state(&interrupted), "failed", "{interrupted}");
    assert_eq!(
        interrupted["safe_error_code"], "turn_interrupted",
        "{interrupted}"
    );
    assert_eq!(interrupted["retryable"], true, "{interrupted}");
    let messages = s.gw.messages("general").await?;
    assert_eq!(messages.iter().filter(|m| m["role"] == "user").count(), 2);
    assert_eq!(
        messages
            .iter()
            .filter(|m| m["role"] == "assistant"
                && m["text"]
                    .as_str()
                    .is_some_and(|text| text.trim() == "waiting"))
            .count(),
        1
    );
    assert_eq!(
        s.provider()?.served(),
        2,
        "interrupted model work was resumed"
    );
    assert!(!s.agent.logs().contains("app_sqlite_owner_closed"));
    eprintln!("active shutdown and queue drain: {:?}", started.elapsed());
    s.finish().await
}
