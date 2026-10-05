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

async fn active_stream(safe_quit: bool) -> Result<(Scenario, String), HarnessError> {
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
    let mut setup = Setup::new("Q-02-SHUTDOWN")?.stub_cassette(cassette);
    if safe_quit {
        setup = setup
            .app_supervisor()
            .env("BUTLER_APP_QUIT_WAIT_SAFELY", "1");
    }
    let s = setup.start().await?;
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
    let (mut s, running) = active_stream(false).await?;
    let live = s.gw.get("/user-work").await?.data().clone();
    assert_eq!(live["classification"], "active_work_detected");
    assert_eq!(live["active_turn_count"], 1);
    assert_eq!(live["queued_message_count"], 0);
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
    let live = s.gw.get("/user-work").await?.data().clone();
    assert_eq!(live["active_turn_count"], 1);
    assert_eq!(live["queued_message_count"], 1);
    assert!(!TERMINAL.contains(&turn_state(&s.gw.turn("general", &running).await?.unwrap())));
    let started = Instant::now();
    // Hold the next process's first inbound poll: FIFO recovery must wait for
    // executor readiness rather than claiming and permanently failing input.
    s.agent.launch.set_env("BUTLER_E2E_TIER", "stub");
    s.agent
        .launch
        .set_env("BUTLER_E2E_HOLD_DISPATCH_READY", "1");
    s.restart().await?;
    assert_pending_before_readiness(&s).await?;
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
    for line in s
        .agent
        .logs()
        .lines()
        .filter(|line| line.contains("[native-shutdown]"))
    {
        eprintln!("{line}");
    }
    let idle = s.gw.get("/user-work").await?.data().clone();
    assert_eq!(idle["classification"], "no_active_work", "{idle}");
    assert_eq!(idle["active_turn_count"], 0);
    assert_eq!(idle["queued_message_count"], 0);
    assert_eq!(idle["delegated_work_present"], false);
    eprintln!("active shutdown and queue drain: {:?}", started.elapsed());
    s.finish().await
}

#[tokio::test]
async fn app_quit_waits_past_budget_and_preserves_the_full_queue() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    let (mut s, running) = active_stream(true).await?;
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
    let db = butler_platform::sqlite::open(s.sandbox.data.join("agent-runtime/btcc.sqlite"))
        .map_err(|e| HarnessError(e.to_string()))?;
    db.execute_batch("BEGIN IMMEDIATE")
        .map_err(|e| HarnessError(e.to_string()))?;
    let started = Instant::now();
    assert!(s.agent.release_foreground_lease());
    let deadline = Instant::now() + Duration::from_secs(8);
    while !s.agent.logs().contains("budget_exceeded_waiting_safely") {
        assert!(
            s.agent.is_running(),
            "App-owned agent force-exited before storage settled"
        );
        assert!(Instant::now() < deadline, "budget status missing");
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
    assert!(s.agent.is_running());
    assert!(!s.agent.logs().contains("deadline_exit"));
    db.execute_batch("ROLLBACK")
        .map_err(|e| HarnessError(e.to_string()))?;
    drop(db);
    let deadline = Instant::now() + Duration::from_secs(10);
    while s.agent.is_running() {
        assert!(
            Instant::now() < deadline,
            "Agent did not finish after storage released"
        );
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
    assert!(s.agent.reap().unwrap().success());
    eprintln!(
        "safe App quit with blocked storage: {:?}",
        started.elapsed()
    );
    s.gw = s.agent.start_again().await?;
    let deadline = Instant::now() + Duration::from_secs(10);
    loop {
        let turns = s.gw.turns("general").await?;
        if turns.iter().any(|turn| turn_state(turn) == "delivered") {
            break;
        }
        assert!(
            Instant::now() < deadline,
            "follow-up not recovered: {turns:?}"
        );
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
    let active = s.gw.turn("general", &running).await?.unwrap();
    assert_eq!(active["safe_error_code"], "turn_interrupted");
    assert_eq!(active["retryable"], true);
    let turns = s.gw.turns("general").await?;
    assert_eq!(turns.len(), 2, "{turns:?}");
    let queue = s.gw.get("/session-queue?chat_id=general").await?;
    assert_eq!(queue.data()["paused"], false);
    assert_eq!(queue.data()["queued_messages"].as_array().unwrap().len(), 1);
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
    assert_eq!(s.provider()?.served(), 2);
    s.finish().await
}

async fn assert_pending_before_readiness(s: &Scenario) -> Result<(), HarnessError> {
    let held = s.sandbox.data.join("e2e-dispatch-ready-held");
    let deadline = Instant::now() + Duration::from_secs(10);
    while !held.exists() {
        assert!(
            Instant::now() < deadline,
            "initial dispatch never reached barrier"
        );
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
    let view = s.gw.get("/session-queue?chat_id=general").await?;
    let items = view.data()["queued_messages"].as_array().unwrap();
    assert_eq!(items.len(), 2, "{}", view.text);
    assert_eq!(items[0]["safe_error_code"], "turn_interrupted");
    assert_eq!(items[1]["state"], "queued", "{}", view.text);
    assert!(items[1]["turn_id"].is_null(), "{}", view.text);
    assert!(items[1]["safe_error_code"].is_null(), "{}", view.text);
    assert_eq!(view.data()["paused"], false);
    assert_eq!(s.provider()?.served(), 1);
    tokio::fs::write(
        s.sandbox.data.join("e2e-dispatch-ready-release"),
        b"release",
    )
    .await?;
    Ok(())
}
