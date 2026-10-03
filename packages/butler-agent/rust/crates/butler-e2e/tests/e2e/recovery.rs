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

use butler_e2e::e2e::events::{LiveEvents, event_turn_id};
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

async fn wait_stream_delta(live: &LiveEvents, turn_id: &str) -> Result<(), HarnessError> {
    live.wait_for(Duration::from_secs(30), |event| {
        event["type"] == "agent.turn_event"
            && event_turn_id(event) == Some(turn_id)
            && event["payload"]["event"]["kind"] == "model.stream.text_delta"
            && event["payload"]["event"]["payload"]["target"] == "final_candidate"
            && event["payload"]["event"]["payload"]["textDelta"]
                .as_str()
                .is_some_and(|text| !text.is_empty())
    })
    .await?;
    Ok(())
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
    butler_e2e::gate!();
    let mut s = Setup::new("REC-02")?.cassette("REC-02").start().await?;
    if s.recording() {
        s.turn("general", LONG).await?;
        return s.finish().await;
    }
    let live = LiveEvents::subscribe(&s.gw, 0).await?;
    let exchange = s.provider()?.exchange_for("one to twelve", 0)?;
    s.provider()?
        .inject(Fault::once(exchange, Transform::StallAfter(6)))?;
    let accepted = s.gw.say("general", LONG).await?;
    let turn_id = accepted_turn_id(&accepted)?;
    wait_served(&s, 1).await;
    wait_stream_delta(&live, &turn_id).await?;
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
async fn rec_02_crash_interrupted_turn_is_failed_not_resumed() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    let mut s = Setup::new("REC-02-OWNER")?
        .cassette("REC-02")
        .replay_only()
        .start()
        .await?;
    let live = LiveEvents::subscribe(&s.gw, 0).await?;
    let exchange = s.provider()?.exchange_for("one to twelve", 0)?;
    s.provider()?
        .inject(Fault::once(exchange, Transform::StallAfter(6)))?;
    let accepted = s.gw.say("general", LONG).await?;
    let turn_id = accepted_turn_id(&accepted)?;
    wait_served(&s, 1).await;
    wait_stream_delta(&live, &turn_id).await?;
    s.crash_and_restart().await?;
    let turn = settled(&mut s, &turn_id).await?;
    assert_eq!(
        turn_state(&turn),
        "failed",
        "crash-interrupted turn: {turn}"
    );
    assert_eq!(turn["retryable"], true, "{turn}");
    assert_retry_current_refused(&s, &turn_id).await?;
    s.finish().await
}

/// `POST /turns/{id}/retry-current` starts a fresh turn, which could run the
/// interrupted turn's completed tool effects again, so it is refused for a
/// crash-interrupted turn (only `/retry`, which resumes, is offered).
async fn assert_retry_current_refused(s: &Scenario, turn_id: &str) -> Result<(), HarnessError> {
    let reply =
        s.gw.post(&format!("/turns/{turn_id}/retry-current"), json!({}))
            .await?;
    assert_eq!(reply.status, 409, "retry-current accepted: {}", reply.text);
    assert_eq!(
        reply.error_code(),
        Some("turn_not_retryable"),
        "{}",
        reply.text
    );
    let turn = s.gw.turn("general", turn_id).await?.unwrap_or_default();
    assert_eq!(
        turn_state(&turn),
        "failed",
        "retry-current changed the turn: {turn}"
    );
    Ok(())
}

const REC03: &str = "Use the run_command tool to run exactly `echo {marker} >> log.txt` in your workspace, then reply done.";

/// Where [`crash_after_effect`] kills the service.
#[derive(Clone, Copy, PartialEq, Eq)]
enum CrashPoint {
    /// As soon as the command's effect is visible in the workspace: the
    /// effect has run and its result may not be journaled yet.
    EffectVisible,
    /// Once the model round after the command is requested: the command's
    /// result is journaled, so record and replay crash at the same point.
    ResultJournaled,
}

/// Starts REC-03 from `cassette`, crashes at `point` after the command ran
/// and restarts. Returns the scenario, turn id and marker.
async fn crash_after_effect(
    id: &str,
    cassette: &str,
    point: CrashPoint,
) -> Result<(Scenario, String, String), HarnessError> {
    let marker = nonce();
    let prompt = REC03.replace("{marker}", &marker);
    let mut s = Setup::new(id)?
        .cassette(cassette)
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
        tokio::time::sleep(Duration::from_millis(5)).await;
    }
    if point == CrashPoint::ResultJournaled {
        let requested = s.provider()?.served();
        let settle = Instant::now() + Duration::from_secs(20);
        while s.provider()?.served() == requested {
            assert!(
                Instant::now() < settle,
                "the model round after the command was never requested"
            );
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
    }
    s.crash_and_restart().await?;
    Ok((s, turn_id, marker))
}

/// How often the REC-03 command's effect happened.
fn effect_count(s: &Scenario, marker: &str) -> Result<usize, HarnessError> {
    Ok(fs::read_to_string(s.sandbox.data.join("log.txt"))?
        .lines()
        .filter(|line| line.contains(marker))
        .count())
}

/// REC-03 — Crash during a tool side effect, killed as soon as the effect is
/// visible (its result may not be journaled yet): the effect happens at most
/// once, the service comes back, and the turn ends failed with retry
/// available instead of being resumed.
#[tokio::test]
async fn rec_03_crash_after_tool_effect_never_duplicates_it() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    let (mut s, turn_id, marker) =
        crash_after_effect("REC-03", "REC-03", CrashPoint::EffectVisible).await?;
    let turn = settled(&mut s, &turn_id).await?;
    assert_eq!(
        turn_state(&turn),
        "failed",
        "crash-interrupted turn not ended failed: {turn}"
    );
    assert_eq!(turn["retryable"], true, "{turn}");
    // Keep supervising for a while: nothing may run the effect again.
    let until = Instant::now() + Duration::from_secs(if s.recording() { 60 } else { 10 });
    while Instant::now() < until {
        s.supervise().await?;
        tokio::time::sleep(Duration::from_millis(200)).await;
    }
    s.supervise().await?;
    let count = effect_count(&s, &marker)?;
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
/// available; retrying resumes it to delivered without running the effect
/// again. It crashes once the command's result is journaled; its recording
/// (gpt-6-luna) holds the model rounds the retry resumes with.
#[tokio::test]
async fn rec_03_crash_after_tool_effect_ends_failed_retryable() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    butler_e2e::skip_unless!(
        butler_platform::command_sandbox::POSIX_SHELL,
        "this scenario replays commands recorded for a POSIX shell; the Windows shell is covered by butler-turn tests"
    );
    let (mut s, turn_id, marker) =
        crash_after_effect("REC-03-OWNER", "REC-03-OWNER", CrashPoint::ResultJournaled).await?;
    let turn = settled(&mut s, &turn_id).await?;
    assert_eq!(turn_state(&turn), "failed", "{turn}");
    assert_eq!(turn["retryable"], true, "{turn}");
    assert_retry_current_refused(&s, &turn_id).await?;
    let retry =
        s.gw.post(&format!("/turns/{turn_id}/retry"), json!({}))
            .await?;
    assert_eq!(retry.status, 202, "{}", retry.text);
    let retried = settled(&mut s, &turn_id).await?;
    assert_eq!(turn_state(&retried), "delivered", "retry: {retried}");
    assert_eq!(effect_count(&s, &marker)?, 1, "effect repeated on retry");
    s.finish().await
}

/// REC-01 — Graceful stop (SIGTERM) during a turn: after start the turn is
/// terminal, never stuck, with zero or one answer.
#[tokio::test]
async fn rec_01_graceful_stop_during_turn() -> Result<(), HarnessError> {
    butler_e2e::gate!();
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
    butler_e2e::gate!();
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

/// A retry arriving after recovery but before dispatch readiness keeps its claim unreserved.
#[tokio::test]
async fn rec_03_retry_waits_for_dispatch_readiness() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    butler_e2e::skip_unless!(
        butler_platform::command_sandbox::POSIX_SHELL,
        "replays a command recorded for a POSIX shell"
    );
    let (mut s, turn_id, marker) =
        crash_after_effect("REC-03-READY", "REC-03-OWNER", CrashPoint::ResultJournaled).await?;
    assert_eq!(turn_state(&settled(&mut s, &turn_id).await?), "failed");
    s.agent.terminate().await?;
    s.agent
        .launch
        .set_env("BUTLER_E2E_HOLD_DISPATCH_READY", "1");
    s.gw = s.agent.start_again().await?;
    let held = s.sandbox.data.join("e2e-dispatch-ready-held");
    let deadline = Instant::now() + Duration::from_secs(10);
    while !held.exists() {
        assert!(Instant::now() < deadline, "dispatcher hold missing");
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
    {
        let path = format!("/turns/{turn_id}/retry");
        let retry = s.gw.post(&path, json!({}));
        tokio::pin!(retry);
        assert!(
            tokio::time::timeout(Duration::from_millis(150), retry.as_mut())
                .await
                .is_err(),
            "retry returned while dispatch was held"
        );
        let turn = s.gw.turn("general", &turn_id).await?.unwrap();
        assert_eq!(
            turn_state(&turn),
            "failed",
            "retry reserved work before readiness"
        );
        fs::write(
            s.sandbox.data.join("e2e-dispatch-ready-release"),
            b"release",
        )?;
        let reply = retry.await?;
        assert_eq!(reply.status, 202, "{}", reply.text);
    }
    assert_eq!(turn_state(&settled(&mut s, &turn_id).await?), "delivered");
    assert_eq!(effect_count(&s, &marker)?, 1, "retry repeated tool effect");
    s.finish().await
}
