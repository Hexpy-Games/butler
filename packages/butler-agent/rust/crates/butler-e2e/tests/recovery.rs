//! J. Restart / crash recovery (SCENARIOS.md REC-02, REC-03, REC-05).
//!
//! Owner decision: a crash-interrupted turn is not auto-resumed; it ends
//! `failed` with retry available, and no tool effect is executed twice.
#![allow(
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::panic,
    reason = "test assertions"
)]

use std::fs;
use std::time::{Duration, Instant};

use butler_e2e::e2e::faults::{Fault, Transform};
use butler_e2e::e2e::gateway::{TERMINAL, turn_state};
use butler_e2e::e2e::scenario::{Scenario, Setup, accepted_turn_id};
use butler_e2e::e2e::{HarnessError, nonce};
use serde_json::{Value, json};

const LONG: &str = "Write the numbers from one to twelve as English words, separated by single spaces, and nothing else.";

async fn wait_served(s: &Scenario, count: u32) {
    let deadline = Instant::now() + Duration::from_secs(30);
    while s
        .provider()
        .map(butler_e2e::e2e::provider::Provider::served)
        .unwrap_or(0)
        < count
    {
        assert!(Instant::now() < deadline, "provider not reached");
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
}

/// Waits (bounded) until the turn is terminal after a restart, acting as the
/// process supervisor (the service exits after an interrupted turn).
async fn settled(s: &mut Scenario, turn_id: &str) -> Result<Value, HarnessError> {
    let deadline = Instant::now() + Duration::from_secs(60);
    loop {
        s.supervise().await?;
        if let Ok(Some(turn)) = s.gw.turn("general", turn_id).await
            && TERMINAL.contains(&turn_state(&turn))
        {
            return Ok(turn);
        }
        if Instant::now() > deadline {
            let last =
                s.gw.turn("general", turn_id)
                    .await
                    .ok()
                    .flatten()
                    .unwrap_or_default();
            return Err(butler_e2e::e2e::harness_error(format!(
                "turn {turn_id} not terminal after restart; last state {:?}",
                turn_state(&last)
            )));
        }
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
}

fn event_ids(events: &[Value]) -> Vec<u64> {
    events
        .iter()
        .filter_map(|event| event["id"].as_u64())
        .collect()
}

/// REC-02 — Crash (SIGKILL) while the provider stream is open.
#[tokio::test]
async fn rec_02_crash_during_streaming_recovers_without_duplicates() -> Result<(), HarnessError> {
    let mut s = Setup::new("REC-02")?.cassette("REC-02").start().await?;
    if s.recording() {
        s.turn("general", LONG).await?;
        return s.finish().await;
    }
    let exchange = s.provider()?.exchange_for("one to twelve", 0)?;
    s.provider()?
        .inject(Fault::once(exchange, Transform::StallAfter(4)))?;
    let accepted = s.gw.say("general", LONG).await?;
    let turn_id = accepted_turn_id(&accepted)?;
    wait_served(&s, 1).await;
    tokio::time::sleep(Duration::from_millis(300)).await;
    let before_crash = event_ids(&s.gw.events_since(0).await?);
    let last_seen = before_crash.last().copied().unwrap_or(0);

    s.crash_and_restart().await?;
    let turn = settled(&mut s, &turn_id).await?;
    assert!(TERMINAL.contains(&turn_state(&turn)), "{turn}");

    // Reconnect from the last seen id: no duplicates, no gaps.
    let replayed = event_ids(&s.gw.events_since(last_seen).await?);
    assert!(replayed.iter().all(|id| *id > last_seen), "{replayed:?}");
    let all = event_ids(&s.gw.events_since(0).await?);
    assert!(
        all.windows(2).all(|pair| pair[1] == pair[0] + 1),
        "event ids not contiguous: {all:?}"
    );
    assert_eq!(
        all[..before_crash.len()],
        before_crash[..],
        "events before the crash changed"
    );

    if turn_state(&turn) == "failed" {
        let retry =
            s.gw.post(&format!("/turns/{turn_id}/retry"), json!({}))
                .await?;
        assert_eq!(retry.status, 202, "{}", retry.text);
    }
    let turn = settled(&mut s, &turn_id).await;
    let messages = s.gw.messages("general").await?;
    let users = messages.iter().filter(|m| m["role"] == "user").count();
    let answers: Vec<&Value> = messages
        .iter()
        .filter(|m| m["role"] == "assistant")
        .collect();
    assert_eq!(
        users, 1,
        "inbound message processed more than once: {messages:?}"
    );
    let delivered =
        s.gw.turns("general")
            .await?
            .into_iter()
            .any(|turn| turn_state(&turn) == "delivered");
    assert!(
        delivered || turn.is_ok_and(|turn| turn_state(&turn) == "delivered"),
        "retry did not deliver"
    );
    assert_eq!(answers.len(), 1, "{answers:?}");
    s.finish().await
}

/// REC-02 (owner decision) — a crash-interrupted turn is not auto-resumed.
#[tokio::test]
#[ignore = "product gap: REC-02-AUTORESUME — after SIGKILL mid-stream the restarted service re-runs the interrupted turn to delivered; the owner decided such turns end failed with retry available"]
async fn rec_02_crash_interrupted_turn_is_failed_not_resumed() -> Result<(), HarnessError> {
    let mut s = Setup::new("REC-02-OWNER")?
        .cassette("REC-02")
        .start()
        .await?;
    let exchange = s.provider()?.exchange_for("one to twelve", 0)?;
    s.provider()?
        .inject(Fault::once(exchange, Transform::StallAfter(4)))?;
    let accepted = s.gw.say("general", LONG).await?;
    let turn_id = accepted_turn_id(&accepted)?;
    wait_served(&s, 1).await;
    tokio::time::sleep(Duration::from_millis(300)).await;
    s.crash_and_restart().await?;
    let turn = settled(&mut s, &turn_id).await?;
    assert_eq!(
        turn_state(&turn),
        "failed",
        "crash-interrupted turn: {turn}"
    );
    assert_eq!(turn["retryable"], true, "{turn}");
    s.finish().await
}

const REC03: &str = "Use the run_command tool to run exactly `echo {marker} >> log.txt` in your workspace, then reply done.";

/// Starts REC-03, crashes right after the command ran, restarts under
/// supervision for a while. Returns the scenario, turn id and marker.
async fn crash_after_effect(id: &str) -> Result<(Scenario, String, String), HarnessError> {
    let marker = nonce();
    let prompt = REC03.replace("{marker}", &marker);
    let mut s = Setup::new(id)?
        .cassette("REC-03")
        .placeholder("NONCE", &marker)
        .start()
        .await?;
    let log = s.sandbox.data.join("log.txt");
    // Hold the model round that follows the command so the crash lands after
    // the effect and before the turn completes. (Record mode crashes at the
    // same point while that live round is in flight.)
    s.provider()?
        .inject(Fault::on_request("log.txt", 11, Transform::StallAfter(0)))?;
    let accepted = s.gw.say("general", &prompt).await?;
    let turn_id = accepted_turn_id(&accepted)?;
    let deadline = Instant::now() + Duration::from_secs(60);
    while !fs::read_to_string(&log)
        .unwrap_or_default()
        .contains(&marker)
    {
        assert!(Instant::now() < deadline, "command never ran");
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
    s.crash_and_restart().await?;
    Ok((s, turn_id, marker))
}

/// REC-03 — Crash during a tool side effect: the effect happens at most once
/// and the service comes back.
#[tokio::test]
async fn rec_03_crash_after_tool_effect_never_duplicates_it() -> Result<(), HarnessError> {
    let (mut s, turn_id, marker) = crash_after_effect("REC-03").await?;
    let log = s.sandbox.data.join("log.txt");
    let until = Instant::now() + Duration::from_secs(if s.recording() { 60 } else { 20 });
    while Instant::now() < until {
        s.supervise().await?;
        tokio::time::sleep(Duration::from_millis(200)).await;
    }
    s.supervise().await?;
    let count = fs::read_to_string(&log)?
        .lines()
        .filter(|line| line.contains(&marker))
        .count();
    assert_eq!(count, 1, "tool effect executed {count} times");
    assert!(s.gw.healthy().await);
    let turn = s.gw.turn("general", &turn_id).await?.unwrap_or_default();
    assert_ne!(
        turn_state(&turn),
        "delivered",
        "crash-interrupted turn reported success without owner-approved resume: {turn}"
    );
    s.finish().await
}

/// REC-03 (owner decision) — the interrupted turn ends failed with retry
/// available; retrying does not run the effect again.
#[tokio::test]
#[ignore = "product gap: REC-03-STUCK — after SIGKILL following a run_command effect, the restarted service resumes the turn, fails with bounded_continuation_item_identity_invalid, exits for process replacement, and the App turn stays `thinking` indefinitely"]
async fn rec_03_crash_after_tool_effect_ends_failed_retryable() -> Result<(), HarnessError> {
    let (mut s, turn_id, marker) = crash_after_effect("REC-03-OWNER").await?;
    let turn = settled(&mut s, &turn_id).await?;
    assert_eq!(turn_state(&turn), "failed", "{turn}");
    assert_eq!(turn["retryable"], true, "{turn}");
    let retry =
        s.gw.post(&format!("/turns/{turn_id}/retry"), json!({}))
            .await?;
    assert_eq!(retry.status, 202, "{}", retry.text);
    let _ = settled(&mut s, &turn_id).await;
    let log = fs::read_to_string(s.sandbox.data.join("log.txt"))?;
    assert_eq!(
        log.lines().filter(|line| line.contains(&marker)).count(),
        1,
        "effect repeated on retry"
    );
    s.finish().await
}

/// REC-01 — Graceful stop (SIGTERM) during a turn: after start the turn is
/// terminal, never stuck, with zero or one answer.
#[tokio::test]
async fn rec_01_graceful_stop_during_turn() -> Result<(), HarnessError> {
    let mut s = Setup::new("REC-01")?.cassette("REC-01").start().await?;
    if !s.recording() {
        s.provider()?.set_pacing(butler_e2e::e2e::provider::Pacing {
            scale: 1.0,
            cap_ms: 300,
            min_ms: 200,
        });
    }
    let accepted = s.gw.say("general", LONG).await?;
    let turn_id = accepted_turn_id(&accepted)?;
    wait_served(&s, 1).await;
    s.agent.terminate().await?;
    s.gw = s.agent.start_again().await?;
    let turn = settled(&mut s, &turn_id).await?;
    assert!(TERMINAL.contains(&turn_state(&turn)), "{turn}");
    let answers =
        s.gw.messages("general")
            .await?
            .iter()
            .filter(|m| m["role"] == "assistant")
            .count();
    assert!(answers <= 1, "{answers} answers");
    s.finish().await
}

/// REC-05 — Stale lock of a dead process; second concurrent start refused.
#[tokio::test]
async fn rec_05_stale_instance_and_second_start() -> Result<(), HarnessError> {
    let mut s = Setup::new("REC-05")?.start().await?;
    // A second service on the same data dir is refused while one runs.
    let mut second = s.agent.launch.clone();
    second.port = butler_e2e::e2e::agent::free_port()?;
    let output = second
        .command()
        .stdin(std::process::Stdio::null())
        .output()?;
    assert!(
        !output.status.success(),
        "second instance started on the same data dir"
    );
    assert!(s.gw.healthy().await);
    // SIGKILL leaves the instance record of a dead pid; start must succeed.
    s.crash_and_restart().await?;
    assert!(s.gw.healthy().await);
    let settings = s.gw.settings().await?;
    assert_eq!(settings["model"], "openai/gpt-6-sol");
    s.finish().await
}
