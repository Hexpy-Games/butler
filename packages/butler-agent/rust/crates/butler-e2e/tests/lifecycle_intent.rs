//! L. Intentional stop signal (#223, SVC-02..SVC-07): `butler stop`,
//! `butler restart` and MCP `restart_butler` announce the exit in
//! `D/state/agent-stop-intent.json` before they signal the service, so the
//! App's supervisor can tell it from a crash; the App starts the replacement
//! of an instance it supervises; the next instance removes the announcement
//! when it is ready. Every intentional stop exits 0 and a crash does not:
//! launchd (`KeepAlive: {SuccessfulExit: false}`) and systemd
//! (`Restart=on-failure`) restart only an Agent that exits non-zero.
#![allow(
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::panic,
    reason = "test assertions"
)]

use std::io::Write;
use std::path::Path;
use std::time::{Duration, Instant};

use butler_e2e::e2e::scenario::{Scenario, Setup};
use butler_e2e::e2e::stop_intent::{
    RestartWatch, StopOnDrop, instance_record, intent_path, mcp_tool_call, read_intent,
};
use butler_e2e::e2e::{HarnessError, harness_error};
use butler_platform::instance::request_stop;
use butler_platform::process_control::{ExitSignal, SIGNALS, terminating_signal};
use butler_platform::secure_fs::{OWNER_ONLY, is_owner_only};
use serde_json::{Value, json};

const INTENT_SCHEMA: &str = "butler.agent-stop-intent.v1";

/// One scenario at a time: they run CLI and MCP controllers back to back and
/// log restart timings, which concurrent agents would skew. (Sandboxes once
/// shared one hard-linked binary, which macOS reports under whichever name was
/// looked up last; each sandbox now has its own copy, and the product's
/// identity check compares files, not names.)
static SERIAL: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());

/// Asserts the announcement a controller wrote for the instance `record`.
fn assert_intent(intent: &Value, reason: &str, requested_by: &str, record: &Value) {
    assert_eq!(intent["schema"], INTENT_SCHEMA, "{intent}");
    assert_eq!(intent["reason"], reason, "{intent}");
    assert_eq!(intent["requested_by"], requested_by, "{intent}");
    let respawn_by = match (reason, record["app_supervised"] == true) {
        ("restart", true) => json!("app"),
        ("restart", false) => json!("controller"),
        _ => Value::Null,
    };
    assert_eq!(intent["respawn_by"], respawn_by, "{intent}");
    assert_eq!(intent["instance_id"], record["nonce"], "{intent}");
    assert_eq!(intent["pid"], record["pid"], "{intent}");
    let requested_at = intent["requested_at"].as_str().unwrap_or_default();
    assert!(
        chrono::DateTime::parse_from_rfc3339(requested_at).is_ok(),
        "requested_at is not RFC 3339: {intent}"
    );
}

/// Asserts that the agent process `pid` the harness started exited with
/// status 0, as every intentional stop must.
fn assert_exited_cleanly(s: &Scenario, pid: u32) {
    let status = s
        .agent
        .exit_status(pid)
        .unwrap_or_else(|| panic!("agent {pid} was not reaped"));
    assert_eq!(
        status.code(),
        Some(0),
        "intentional stop of agent {pid} exited with {status}"
    );
}

/// Waits (bounded) for the harness's agent process to exit and collects it.
async fn wait_exited(s: &mut Scenario) {
    let deadline = Instant::now() + Duration::from_secs(30);
    while s.agent.is_running() {
        assert!(Instant::now() < deadline, "the agent did not exit");
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
    s.agent.reap();
}

/// The instance record of the process `pid` while it is still starting.
async fn starting_record(data: &Path, pid: u32) -> Value {
    let deadline = Instant::now() + Duration::from_secs(30);
    loop {
        if let Some(record) = instance_record(data)
            .filter(|record| record["pid"] == pid && record["state"] == "starting")
        {
            return record;
        }
        assert!(
            Instant::now() < deadline,
            "agent {pid} was never seen starting"
        );
        tokio::time::sleep(Duration::from_millis(5)).await;
    }
}

/// SVC-02 — `butler stop` sticks: it announces an intended stop before the
/// service exits, tells the user schedules stop too, and nothing brings the
/// service back until it is started again, which clears the announcement.
#[tokio::test]
async fn svc_02_stop_is_announced_and_sticks() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    let _serial = SERIAL.lock().await;
    let mut s = Setup::new("SVC-02")?.start().await?;
    let data = s.sandbox.data.clone();
    let record =
        butler_e2e::e2e::readiness::wait_ready(&data, &s.gw, Duration::from_secs(30), |_| true)
            .await?;
    let pid = s.agent.pid().unwrap();
    assert_eq!(record["pid"], pid);

    // Hold the exited child unreaped until stop returns: a successful stop
    // must recognize the exit even while its PID is still a zombie.
    let stopped = s.agent.cli(&["stop"])?;
    assert_eq!(stopped.code, Some(0), "{stopped:?}");
    assert!(
        stopped.stdout.contains("Butler native service stopped"),
        "{stopped:?}"
    );
    assert!(
        stopped
            .stdout
            .lines()
            .any(|line| line.contains("schedules stop too until Butler starts again")),
        "stop output does not mention schedules: {stopped:?}"
    );
    let intent = read_intent(&data).expect("stop wrote no intent");
    assert_intent(&intent, "stop", "cli", &record);
    let metadata = std::fs::metadata(intent_path(&data))?;
    assert_eq!(is_owner_only(&metadata), OWNER_ONLY.then_some(true));

    wait_exited(&mut s).await;
    assert_exited_cleanly(&s, pid);
    // Stays stopped: the service does not come back by itself.
    tokio::time::sleep(Duration::from_secs(3)).await;
    assert!(!s.gw.healthy().await);
    assert!(instance_record(&data).is_none(), "an instance came back");
    assert_eq!(
        read_intent(&data),
        Some(intent),
        "intent changed while stopped"
    );

    // Starting again (the App's start action) clears the announcement at ready.
    s.gw = s.agent.start_again().await?;
    let again =
        butler_e2e::e2e::readiness::wait_ready(&data, &s.gw, Duration::from_secs(30), |_| true)
            .await?;
    assert_ne!(again["nonce"], record["nonce"]);
    assert!(
        read_intent(&data).is_none(),
        "intent survived a new ready instance"
    );
    s.finish().await
}

/// SVC-03 — `butler restart` announces a restart for the running instance,
/// a new instance comes up, and the announcement is gone once it is ready.
#[tokio::test]
async fn svc_03_restart_is_announced_until_the_new_instance_is_ready() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    let _serial = SERIAL.lock().await;
    let mut s = Setup::new("SVC-03")?.start().await?;
    let cleanup = StopOnDrop(s.agent.launch.clone());
    let data = s.sandbox.data.clone();
    let before =
        butler_e2e::e2e::readiness::wait_ready(&data, &s.gw, Duration::from_secs(30), |_| true)
            .await?;
    // Started without the App's foreground lease: the controller restarts it.
    assert_eq!(before["app_supervised"], false, "{before}");
    let old_pid = s.agent.pid().unwrap();

    let started = Instant::now();
    let mut watch = RestartWatch::default();
    let mut command = s.agent.launch.command();
    command.args(["restart", "--json"]);
    let restart = s
        .agent
        .command_reaping(command, || {
            watch.observe(&data, &before["nonce"], started);
        })
        .await?;
    let returned = started.elapsed();
    assert_eq!(restart.code, Some(0), "{restart:?}");
    let restart = restart.json()?;
    assert_eq!(restart["ok"], true, "{restart}");

    let (intent, announced) = watch.intent.expect("restart wrote no intent");
    assert_intent(&intent, "restart", "cli", &before);
    let after = instance_record(&data).expect("no instance after restart");
    assert_eq!(after["state"], "ready");
    assert_ne!(after["nonce"], before["nonce"]);
    assert_ne!(after["pid"], before["pid"]);
    assert_eq!(restart["data"]["pid"], after["pid"]);
    assert!(read_intent(&data).is_none(), "intent survived the restart");
    assert_exited_cleanly(&s, old_pid);
    // Written to the process stderr directly, not through the captured
    // `eprintln!`, so the timing shows in the log of a passing run too.
    let _ = writeln!(
        std::io::stderr(),
        "SVC-03 timing: intent written {announced:?}, new instance ready {:?}, restart returned {returned:?}",
        watch.ready
    );
    drop(cleanup);
    s.finish().await
}

/// SVC-04 — restarting an agent the App supervises keeps the App's instance.
/// The agent runs with the App's environment: foreground lease, gateway token
/// only in the App's file in D, App gateway forced on although
/// `gateways/app.json` disables it. From a terminal without the App's
/// variables, `butler start` reports it running (not
/// `native_service_app_health_auth_unavailable`); MCP `restart_butler` and
/// `butler restart` announce a restart the App carries out, report success
/// once it is ready, and each replacement is again the App's child with local
/// auth and the App gateway on the App's port.
#[tokio::test]
async fn svc_04_restart_keeps_the_app_supervised_instance() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    let _serial = SERIAL.lock().await;
    let setup = Setup::new("SVC-04")?.app_supervisor();
    let gateways = setup.sandbox.data.join("gateways");
    std::fs::create_dir_all(&gateways)?;
    std::fs::write(
        gateways.join("app.json"),
        json!({"enabled": false}).to_string(),
    )?;
    let mut s = setup.start().await?;
    let cleanup = StopOnDrop(s.agent.launch.clone());
    let data = s.sandbox.data.clone();
    let first =
        butler_e2e::e2e::readiness::wait_ready(&data, &s.gw, Duration::from_secs(30), |_| true)
            .await?;
    assert_app_instance(&first, &s);

    let mut command = s.agent.launch.command_without_local_auth();
    command.args(["start", "--json"]);
    let start = s.agent.command_reaping(command, || {}).await?;
    assert_eq!(start.code, Some(0), "{start:?}");
    let start = start.json()?;
    assert_eq!(start["data"]["alreadyRunning"], true, "{start}");
    assert_eq!(start["data"]["pid"], first["pid"], "{start}");

    let (reply, intent) = restart_butler_over_mcp(&mut s, &first).await?;
    assert_ne!(reply["result"]["isError"], true, "{reply}");
    assert_intent(&intent, "restart", "mcp", &first);
    let second =
        butler_e2e::e2e::readiness::wait_ready(&data, &s.gw, Duration::from_secs(30), |_| true)
            .await?;
    assert_ne!(second["nonce"], first["nonce"]);
    assert_app_instance(&second, &s);
    assert_exited_cleanly(&s, pid_of(&first));
    let text = reply["result"]["content"][0]["text"].as_str().unwrap_or("");
    assert!(
        text.contains(&format!("restarted (pid={})", second["pid"])),
        "{reply}"
    );
    assert!(read_intent(&data).is_none(), "intent survived the restart");

    let started = Instant::now();
    let mut watch = RestartWatch::default();
    let mut command = s.agent.launch.command_without_local_auth();
    command.args(["restart", "--json"]);
    let restart = s
        .agent
        .command_reaping(command, || {
            watch.observe(&data, &second["nonce"], started);
        })
        .await?;
    assert_eq!(restart.code, Some(0), "{restart:?}");
    let restart = restart.json()?;
    let (intent, _) = watch.intent.expect("restart wrote no intent");
    assert_intent(&intent, "restart", "cli", &second);
    let third =
        butler_e2e::e2e::readiness::wait_ready(&data, &s.gw, Duration::from_secs(30), |_| true)
            .await?;
    assert_ne!(third["nonce"], second["nonce"]);
    assert_app_instance(&third, &s);
    assert_exited_cleanly(&s, pid_of(&second));
    assert_eq!(restart["data"]["pid"], third["pid"], "{restart}");
    drop(cleanup);
    s.finish().await
}

fn pid_of(record: &Value) -> u32 {
    record["pid"]
        .as_u64()
        .and_then(|pid| u32::try_from(pid).ok())
        .unwrap_or_else(|| panic!("no pid in {record}"))
}

/// Asserts that `record` is the instance the App started (the harness's
/// child) and that it runs with the App's environment.
fn assert_app_instance(record: &Value, s: &Scenario) {
    let child = s.agent.pid().expect("the App's child is running");
    assert_eq!(record["pid"], child, "not the App's child: {record}");
    assert_eq!(record["app_supervised"], true, "{record}");
    assert_eq!(record["app_enabled"], true, "App gateway lost: {record}");
    assert_eq!(
        record["app_auth_required"], true,
        "local auth lost: {record}"
    );
    let endpoint = format!("http://127.0.0.1:{}", s.agent.launch.port);
    assert_eq!(record["app_endpoint"], endpoint.as_str(), "{record}");
}

/// Calls MCP `restart_butler` from a terminal environment while the harness
/// supervises the agent; returns the reply and the intent seen meanwhile.
async fn restart_butler_over_mcp(
    s: &mut Scenario,
    before: &Value,
) -> Result<(Value, Value), HarnessError> {
    let data = s.sandbox.data.clone();
    let nonce = before["nonce"].clone();
    let started = Instant::now();
    let mut watch = RestartWatch::default();
    let mut command = s.agent.launch.command_without_local_auth();
    command.arg("--data").arg(&data).args(["mcp", "serve"]);
    let mcp_log = s.sandbox.logs.join("mcp-serve.log");
    let reply = s
        .agent
        .while_reaping(
            move || mcp_tool_call(command, &mcp_log, "restart_butler"),
            || watch.observe(&data, &nonce, started),
        )
        .await??;
    let (intent, _) = watch
        .intent
        .ok_or_else(|| harness_error("restart_butler wrote no intent"))?;
    Ok((reply, intent))
}

/// SVC-06 — a stop whose announcement cannot be written is not delivered:
/// the service keeps running with its record `ready`, so gateway control and
/// `butler start` still accept it. Once the intent can be written, `stop`
/// works.
#[tokio::test]
async fn svc_06_undeliverable_stop_leaves_the_service_ready() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    let _serial = SERIAL.lock().await;
    let mut s = Setup::new("SVC-06")?.start().await?;
    let data = s.sandbox.data.clone();
    let record =
        butler_e2e::e2e::readiness::wait_ready(&data, &s.gw, Duration::from_secs(30), |_| true)
            .await?;
    // A directory where the intent goes: its atomic rename into place fails.
    std::fs::create_dir_all(intent_path(&data).join("occupied"))?;

    let refused = s.agent.cli_reaping(&["stop", "--json"]).await?;
    assert_ne!(refused.code, Some(0), "{refused:?}");
    assert!(
        format!("{}{}", refused.stdout, refused.stderr)
            .contains("native_service_stop_intent_unavailable"),
        "{refused:?}"
    );
    assert!(
        s.agent.is_running(),
        "an undelivered stop ended the service"
    );
    let after = instance_record(&data).expect("the instance record is gone");
    assert_eq!(after["nonce"], record["nonce"], "{after}");
    assert_eq!(after["state"], "ready", "record left half stopped: {after}");
    let health = s.gw.get("/health").await?;
    assert_eq!(health.status, 200, "{}", health.text);
    let start = s.agent.cli(&["start", "--json"])?.json()?;
    assert_eq!(start["data"]["alreadyRunning"], true, "{start}");

    std::fs::remove_dir_all(intent_path(&data))?;
    let stopped = s.agent.cli_reaping(&["stop", "--json"]).await?;
    assert_eq!(stopped.code, Some(0), "{stopped:?}");
    let intent = read_intent(&data).expect("stop wrote no intent");
    assert_intent(&intent, "stop", "cli", &record);
    wait_exited(&mut s).await;
    assert_exited_cleanly(&s, pid_of(&record));
    s.finish().await
}

/// SVC-05 — a crash is never announced: a stale announcement is cleared when
/// an instance becomes ready, and SIGKILL of that instance leaves none.
#[tokio::test]
async fn svc_05_crash_leaves_no_intent() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    let _serial = SERIAL.lock().await;
    let setup = Setup::new("SVC-05")?;
    let data = setup.sandbox.data.clone();
    std::fs::create_dir_all(data.join("state"))?;
    let stale = json!({
        "schema": INTENT_SCHEMA, "reason": "stop", "requested_by": "app",
        "instance_id": "stale-instance", "pid": 1, "requested_at": "2026-09-27T00:00:00.000Z",
    });
    std::fs::write(intent_path(&data), stale.to_string())?;
    let mut s = setup.start().await?;
    butler_e2e::e2e::readiness::wait_ready(&data, &s.gw, Duration::from_secs(30), |_| true).await?;
    assert!(read_intent(&data).is_none(), "stale intent survived ready");

    let pid = s.agent.pid().unwrap();
    s.agent.kill9()?;
    assert!(read_intent(&data).is_none(), "a crash left an intent");
    // A crash is not a successful exit: launchd and systemd restart it.
    let status = s
        .agent
        .exit_status(pid)
        .expect("the killed agent was reaped");
    assert!(!status.success(), "a crash exited {status}");
    assert_eq!(
        terminating_signal(status),
        SIGNALS.then_some(ExitSignal::Kill),
        "{status}"
    );
    s.gw = s.agent.start_again().await?;
    butler_e2e::e2e::readiness::wait_ready(&data, &s.gw, Duration::from_secs(30), |_| true).await?;
    assert!(read_intent(&data).is_none());
    s.finish().await
}

/// SVC-07 — a stop that arrives while the service is still starting ends it
/// with status 0 and it stays stopped: `butler stop` (announced) and a plain
/// SIGTERM (launchd or systemd stopping it) alike. A later start is clean.
#[tokio::test]
async fn svc_07_stop_during_startup_exits_zero() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    let _serial = SERIAL.lock().await;
    let mut s = Setup::new("SVC-07")?.start().await?;
    let data = s.sandbox.data.clone();
    butler_e2e::e2e::readiness::wait_ready(&data, &s.gw, Duration::from_secs(30), |_| true).await?;
    let stopped = s.agent.cli_reaping(&["stop", "--json"]).await?;
    assert_eq!(stopped.code, Some(0), "{stopped:?}");
    wait_exited(&mut s).await;

    // `butler stop` while the instance is starting.
    let pid = s.agent.start_process()?;
    let starting = starting_record(&data, pid).await;
    let stopped = s.agent.cli_reaping(&["stop", "--json"]).await?;
    assert_eq!(stopped.code, Some(0), "{stopped:?}");
    assert_eq!(stopped.json()?["data"]["pid"], pid, "{stopped:?}");
    let intent = read_intent(&data).expect("stop wrote no intent");
    assert_intent(&intent, "stop", "cli", &starting);
    wait_exited(&mut s).await;
    assert_exited_cleanly(&s, pid);
    assert!(
        instance_record(&data).is_none(),
        "a stopped startup left its record"
    );
    assert!(!s.gw.healthy().await, "the stopped startup still serves");

    // SIGTERM while the instance is starting, without an announcement.
    if SIGNALS {
        let pid = s.agent.start_process()?;
        starting_record(&data, pid).await;
        request_stop(pid).map_err(|error| harness_error(error.to_string()))?;
        wait_exited(&mut s).await;
        assert_exited_cleanly(&s, pid);
        assert!(
            instance_record(&data).is_none(),
            "{:?}",
            instance_record(&data)
        );
    } else {
        eprintln!("butler-e2e: SKIPPED (unannounced stop: this host has no stop signals)");
    }

    s.gw = s.agent.start_again().await?;
    butler_e2e::e2e::readiness::wait_ready(&data, &s.gw, Duration::from_secs(30), |_| true).await?;
    assert!(
        read_intent(&data).is_none(),
        "intent survived a new ready instance"
    );
    s.finish().await
}
