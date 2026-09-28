//! J/L. Restart handoff and service lifecycle (SCENARIOS.md REC-04, SVC-01,
//! SVC-08).
#![allow(
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::panic,
    reason = "test assertions"
)]

use std::time::{Duration, Instant};

use butler_e2e::e2e::HarnessError;
use butler_e2e::e2e::gateway::{Gateway, TERMINAL, turn_state};
use butler_e2e::e2e::scenario::{Scenario, Setup};
use butler_e2e::e2e::stop_intent::{instance_record, read_intent};

async fn reachable(gw: &Gateway, within: Duration) -> bool {
    let deadline = Instant::now() + within;
    while Instant::now() < deadline {
        if gw.healthy().await {
            return true;
        }
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
    false
}

/// Stops whatever service instance owns the data dir (detached restarts).
fn stop(s: &Scenario) {
    let _ = s.agent.cli(&["stop", "--json"]);
}

/// REC-04 — `butler restart` keeps clients working: gateway back on the same
/// address, settings unchanged, the event log resumable from the last id.
#[tokio::test]
async fn rec_04_restart_keeps_clients_working() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    let mut s = Setup::new("REC-04")?.start().await?;
    let reply =
        s.gw.patch("/settings", serde_json::json!({"language": "ko"}))
            .await?;
    assert_eq!(reply.status, 200);
    let before = s.gw.settings().await?;
    let events = s.gw.events_since(0).await?;
    let last = events
        .last()
        .and_then(|event| event["id"].as_u64())
        .unwrap_or(0);
    let old_pid = s.agent.pid();

    let restart = s.agent.cli_reaping(&["restart", "--json"]).await?;
    assert_eq!(
        restart.code,
        Some(0),
        "{} {}",
        restart.stdout,
        restart.stderr
    );
    let restart = restart.json()?;
    assert_eq!(restart["ok"], true, "{restart}");
    assert!(
        reachable(&s.gw, Duration::from_secs(60)).await,
        "gateway not reachable after restart"
    );
    let status = s.agent.cli(&["status", "--json"])?;
    assert_eq!(status.code, Some(0), "{}", status.stderr);
    assert_ne!(
        restart["data"]["pid"]
            .as_u64()
            .and_then(|pid| u32::try_from(pid).ok()),
        old_pid,
        "same process after restart"
    );
    let after = s.gw.settings().await?;
    assert_eq!(after["language"], before["language"]);
    assert_eq!(after["model"], before["model"]);
    let resumed = s.gw.events_since(last).await?;
    assert!(
        resumed
            .iter()
            .all(|event| event["id"].as_u64().unwrap_or(0) > last),
        "{resumed:?}"
    );
    stop(&s);
    s.finish().await
}

/// REC-04 (mid-turn) — a restart during a turn leaves it terminal, never stuck.
#[tokio::test]
async fn rec_04_restart_mid_turn_settles_the_turn() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    // Replays the REC-01 recording (same request); only REC-01 records it.
    let mut s = Setup::new("REC-04-TURN")?
        .cassette("REC-01")
        .replay_only()
        .start()
        .await?;
    s.provider()?.set_pacing(butler_e2e::e2e::provider::Pacing {
        scale: 1.0,
        cap_ms: 300,
        min_ms: 200,
    });
    let accepted = s
        .gw
        .say("general", "Write the numbers from one to twelve as English words, separated by single spaces, and nothing else.")
        .await?;
    let turn_id = butler_e2e::e2e::scenario::accepted_turn_id(&accepted)?;
    let deadline = Instant::now() + Duration::from_secs(20);
    while s.provider()?.served() == 0 {
        assert!(Instant::now() < deadline);
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
    let restart = s.agent.cli_reaping(&["restart", "--json"]).await?;
    assert_eq!(
        restart.code,
        Some(0),
        "{} {}",
        restart.stdout,
        restart.stderr
    );
    assert!(reachable(&s.gw, Duration::from_secs(60)).await);
    let turn =
        s.gw.wait_turn("general", &turn_id, TERMINAL, Duration::from_secs(60))
            .await?;
    assert!(TERMINAL.contains(&turn_state(&turn)), "{turn}");
    let answers =
        s.gw.messages("general")
            .await?
            .iter()
            .filter(|m| m["role"] == "assistant")
            .count();
    assert!(answers <= 1, "{answers} answers");
    stop(&s);
    s.finish().await
}

/// SVC-01 — status/stop/start through the CLI agree with the process table;
/// logs live under D.
#[tokio::test]
async fn svc_01_service_lifecycle() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    let mut s = Setup::new("SVC-01")?.start().await?;
    let status = s.agent.cli(&["status", "--json"])?;
    assert_eq!(status.code, Some(0), "{}", status.stderr);
    let test = s.agent.cli(&["gateway", "test", "app", "--json"])?.json()?;
    assert_eq!(test["data"]["status"], "online", "{test}");
    let doctor = s.agent.cli(&["doctor", "--json"])?;
    let doctor_json = doctor.json()?;
    assert_eq!(doctor_json["command"], "butler doctor");
    for check in doctor_json["data"]["checks"].as_array().unwrap() {
        // The installed-manifest checks fail in a dev layout (no release manifest).
        if !matches!(check["id"].as_str(), Some("version" | "integrity")) {
            assert_ne!(check["status"], "fail", "doctor check failed: {check}");
        }
    }

    let stopped = s.agent.cli_reaping(&["stop", "--json"]).await?;
    assert_eq!(
        stopped.code,
        Some(0),
        "{} {}",
        stopped.stdout,
        stopped.stderr
    );
    let deadline = Instant::now() + Duration::from_secs(30);
    while s.agent.is_running() {
        assert!(Instant::now() < deadline, "stop did not end the service");
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
    assert!(!s.gw.healthy().await);
    s.agent.reap();

    s.gw = s.agent.start_again().await?;
    assert!(s.gw.healthy().await);
    let fingerprint = s.sandbox.installation_fingerprint()?;
    assert!(
        !fingerprint
            .iter()
            .any(|(path, _, _)| path.ends_with(".log") || path.contains("logs/")),
        "logs written into the installation dir: {fingerprint:?}"
    );
    s.finish().await
}

/// SVC-01 (inject) — a port already in use is a clear start failure.
#[tokio::test]
#[ignore = "product gap: SVC-01-PORT — when the App port is in use the service logs `[native-app] unavailable code=app_listener_bind_failed` and keeps running without its gateway instead of exiting non-zero"]
async fn svc_01_port_in_use_fails_start() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    let mut s = Setup::new("SVC-01-PORT")?.start().await?;
    let stopped = s.agent.cli_reaping(&["stop", "--json"]).await?;
    assert_eq!(stopped.code, Some(0), "{}", stopped.stderr);
    s.agent.reap();
    // Occupy the port, then start: the process must exit non-zero with a
    // clear error, config intact.
    let config_before = std::fs::read(s.sandbox.data.join("butler.config.json"))?;
    let blocker = std::net::TcpListener::bind(("127.0.0.1", s.agent.launch.port))?;
    let (code, text) = run_bounded(&s, Duration::from_secs(30))?;
    drop(blocker);
    assert!(
        code.is_some_and(|code| code != 0),
        "start on a port in use did not fail (exit {code:?}): {text}"
    );
    let text = text.to_lowercase();
    assert!(
        text.contains("port") || text.contains("address") || text.contains("bind"),
        "unclear port error: {text}"
    );
    assert_eq!(
        std::fs::read(s.sandbox.data.join("butler.config.json"))?,
        config_before
    );

    Ok(())
}

/// Runs the service command to completion or kills it after `limit`.
/// Returns the exit code (`None` when it had to be killed) and its output.
fn run_bounded(s: &Scenario, limit: Duration) -> Result<(Option<i32>, String), HarnessError> {
    let log = s.sandbox.logs.join("bounded.log");
    let file = std::fs::File::create(&log)?;
    let mut child = s
        .agent
        .launch
        .command()
        .stdin(std::process::Stdio::null())
        .stdout(file.try_clone()?)
        .stderr(file)
        .spawn()?;
    let deadline = Instant::now() + limit;
    let code = loop {
        if let Some(status) = child.try_wait()? {
            break status.code();
        }
        if Instant::now() > deadline {
            let _ = child.kill();
            let _ = child.wait();
            break None;
        }
        std::thread::sleep(Duration::from_millis(100));
    };
    Ok((code, std::fs::read_to_string(&log).unwrap_or_default()))
}

/// SVC-08 — the App releasing its foreground lease (closing the agent's
/// stdin, as when the App quits) is a requested stop: the agent exits 0
/// without an announcement, removes its record and stays stopped.
#[tokio::test]
async fn svc_08_released_foreground_lease_stops_cleanly() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    let mut s = Setup::new("SVC-08")?.app_supervisor().start().await?;
    let data = s.sandbox.data.clone();
    let deadline = Instant::now() + Duration::from_secs(30);
    let record = loop {
        if let Some(record) = instance_record(&data).filter(|record| record["state"] == "ready") {
            break record;
        }
        assert!(Instant::now() < deadline, "no ready instance record");
        tokio::time::sleep(Duration::from_millis(50)).await;
    };
    assert_eq!(record["app_supervised"], true, "{record}");
    let pid = s.agent.pid().expect("the App's child runs");
    assert_eq!(record["pid"], pid, "{record}");

    assert!(s.agent.release_foreground_lease(), "no leased agent runs");
    let deadline = Instant::now() + Duration::from_secs(30);
    while s.agent.is_running() {
        assert!(Instant::now() < deadline, "the agent did not exit");
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
    let status = s.agent.reap().expect("the exited agent is reaped");
    assert_eq!(status.code(), Some(0), "a released lease exited {status}");
    assert!(
        read_intent(&data).is_none(),
        "a lease release was announced"
    );
    assert!(
        instance_record(&data).is_none(),
        "the stopped agent left its record"
    );
    assert!(!s.gw.healthy().await, "the stopped agent still serves");
    s.finish().await
}
