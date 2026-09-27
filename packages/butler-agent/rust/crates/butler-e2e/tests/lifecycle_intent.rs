//! L. Intentional stop signal (#223, SVC-02..SVC-05): `butler stop`,
//! `butler restart` and MCP `restart_butler` announce the exit in
//! `D/state/agent-stop-intent.json` before they signal the service, so the
//! App's supervisor can tell it from a crash; the next instance removes the
//! announcement when it is ready.
#![allow(
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::panic,
    reason = "test assertions"
)]

use std::io::{BufRead, BufReader, Write};
use std::os::unix::fs::PermissionsExt;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::mpsc;
use std::time::{Duration, Instant};

use butler_e2e::e2e::agent::Launch;
use butler_e2e::e2e::gateway::Gateway;
use butler_e2e::e2e::scenario::Setup;
use butler_e2e::e2e::{HarnessError, harness_error};
use serde_json::{Value, json};

const INTENT_SCHEMA: &str = "butler.agent-stop-intent.v1";

/// One scenario at a time. The sandboxes hard-link one agent binary, and macOS
/// reports a process's executable path from its file's most recent lookup:
/// while another sandbox runs the same file, the product's identity check can
/// see that sandbox's path and refuse to signal (`lock owner does not match
/// its record`). These scenarios run CLI and MCP controllers back to back.
static SERIAL: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());

fn intent_path(data: &Path) -> PathBuf {
    data.join("state/agent-stop-intent.json")
}

fn read_json(path: &Path) -> Option<Value> {
    std::fs::read(path)
        .ok()
        .and_then(|bytes| serde_json::from_slice(&bytes).ok())
}

fn read_intent(data: &Path) -> Option<Value> {
    read_json(&intent_path(data))
}

fn instance_record(data: &Path) -> Option<Value> {
    read_json(&data.join("state/butler-agent-native-service.json"))
}

/// The ready instance record, once the service has marked itself ready (its
/// gateway answers a little earlier).
async fn ready_record(data: &Path, within: Duration) -> Value {
    let deadline = Instant::now() + within;
    loop {
        if let Some(record) = instance_record(data).filter(|record| record["state"] == "ready") {
            return record;
        }
        assert!(Instant::now() < deadline, "no ready instance record");
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
}

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

/// Asserts the announcement a controller wrote for the instance `record`.
fn assert_intent(intent: &Value, reason: &str, requested_by: &str, record: &Value) {
    assert_eq!(intent["schema"], INTENT_SCHEMA, "{intent}");
    assert_eq!(intent["reason"], reason, "{intent}");
    assert_eq!(intent["requested_by"], requested_by, "{intent}");
    assert_eq!(intent["instance_id"], record["nonce"], "{intent}");
    assert_eq!(intent["pid"], record["pid"], "{intent}");
    let requested_at = intent["requested_at"].as_str().unwrap_or_default();
    assert!(
        chrono::DateTime::parse_from_rfc3339(requested_at).is_ok(),
        "requested_at is not RFC 3339: {intent}"
    );
}

/// What a watcher of `D/state` sees while a restart runs.
#[derive(Default)]
struct RestartWatch {
    intent: Option<(Value, Duration)>,
    ready: Option<Duration>,
}

impl RestartWatch {
    fn observe(&mut self, data: &Path, old_nonce: &Value, started: Instant) {
        if self.intent.is_none()
            && let Some(intent) = read_intent(data)
        {
            self.intent = Some((intent, started.elapsed()));
        }
        if self.ready.is_none()
            && instance_record(data)
                .is_some_and(|record| record["state"] == "ready" && &record["nonce"] != old_nonce)
        {
            self.ready = Some(started.elapsed());
        }
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
    let record = ready_record(&data, Duration::from_secs(30)).await;
    assert_eq!(record["pid"], s.agent.pid().unwrap());

    let stopped = s.agent.cli_reaping(&["stop"]).await?;
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
    let mode = std::fs::metadata(intent_path(&data))?.permissions().mode();
    assert_eq!(mode & 0o777, 0o600);

    let deadline = Instant::now() + Duration::from_secs(30);
    while s.agent.is_running() {
        assert!(Instant::now() < deadline, "stop did not end the service");
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
    s.agent.reap();
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
    let again = ready_record(&data, Duration::from_secs(30)).await;
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
    let before = ready_record(&data, Duration::from_secs(30)).await;

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
    assert!(reachable(&s.gw, Duration::from_secs(30)).await);
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

/// SVC-04 — next to an agent the App started (its gateway token only in the
/// App's file in D), `butler start`, `butler restart` and MCP
/// `restart_butler` from an environment without that token report success
/// truthfully instead of `native_service_app_health_auth_unavailable`.
#[tokio::test]
async fn svc_04_controls_report_success_without_the_app_token() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    let _serial = SERIAL.lock().await;
    let mut s = Setup::new("SVC-04")?.app_local_auth().start().await?;
    let cleanup = StopOnDrop(s.agent.launch.clone());
    let data = s.sandbox.data.clone();
    let first = ready_record(&data, Duration::from_secs(30)).await;
    assert_eq!(first["app_auth_required"], true, "{first}");

    let mut command = s.agent.launch.command_without_local_auth();
    command.args(["start", "--json"]);
    let start = s.agent.command_reaping(command, || {}).await?;
    assert_eq!(start.code, Some(0), "{start:?}");
    let start = start.json()?;
    assert_eq!(start["data"]["alreadyRunning"], true, "{start}");
    assert_eq!(start["data"]["pid"], first["pid"], "{start}");

    let started = Instant::now();
    let mut watch = RestartWatch::default();
    let mut command = s.agent.launch.command_without_local_auth();
    command.arg("--data").arg(&data).args(["mcp", "serve"]);
    let mcp_log = s.sandbox.logs.join("mcp-serve.log");
    let reply = s
        .agent
        .while_reaping(
            move || mcp_tool_call(command, &mcp_log, "restart_butler"),
            || watch.observe(&data, &first["nonce"], started),
        )
        .await??;
    assert_ne!(reply["result"]["isError"], true, "{reply}");
    let text = reply["result"]["content"][0]["text"].as_str().unwrap_or("");
    assert!(text.contains("restarted"), "{reply}");
    let (intent, _) = watch.intent.expect("restart_butler wrote no intent");
    assert_intent(&intent, "restart", "mcp", &first);
    let second = ready_record(&data, Duration::from_secs(30)).await;
    assert_ne!(second["nonce"], first["nonce"]);
    assert!(read_intent(&data).is_none(), "intent survived the restart");
    assert!(reachable(&s.gw, Duration::from_secs(30)).await);

    let mut command = s.agent.launch.command_without_local_auth();
    command.args(["restart", "--json"]);
    let restart = s.agent.command_reaping(command, || {}).await?;
    assert_eq!(restart.code, Some(0), "{restart:?}");
    assert_eq!(restart.json()?["ok"], true, "{restart:?}");
    let third = ready_record(&data, Duration::from_secs(30)).await;
    assert_ne!(third["nonce"], second["nonce"]);
    assert!(reachable(&s.gw, Duration::from_secs(30)).await);
    drop(cleanup);
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
    ready_record(&data, Duration::from_secs(30)).await;
    assert!(read_intent(&data).is_none(), "stale intent survived ready");

    s.agent.kill9()?;
    assert!(read_intent(&data).is_none(), "a crash left an intent");
    s.gw = s.agent.start_again().await?;
    ready_record(&data, Duration::from_secs(30)).await;
    assert!(read_intent(&data).is_none());
    s.finish().await
}

/// Stops whatever service instance owns the data dir when dropped, so a
/// failed assertion does not leave the detached service a restart started.
/// Dropped explicitly before `Scenario::finish` removes the data dir.
struct StopOnDrop(Launch);

impl Drop for StopOnDrop {
    fn drop(&mut self) {
        let mut command = self.0.command();
        let _ = command
            .args(["stop", "--json"])
            .stdin(Stdio::null())
            .output();
    }
}

/// Calls one tool of `butler mcp serve` over stdio as an MCP client does and
/// returns the JSON-RPC reply.
fn mcp_tool_call(mut command: Command, log: &Path, tool: &str) -> Result<Value, HarnessError> {
    let mut child = command
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(std::fs::File::create(log)?)
        .spawn()?;
    let mut stdin = child
        .stdin
        .take()
        .ok_or_else(|| harness_error("no MCP stdin"))?;
    let stdout = child
        .stdout
        .take()
        .ok_or_else(|| harness_error("no MCP stdout"))?;
    let (lines, replies) = mpsc::channel();
    std::thread::spawn(move || {
        for line in BufReader::new(stdout).lines().map_while(Result::ok) {
            if lines.send(line).is_err() {
                break;
            }
        }
    });
    let initialize = json!({"jsonrpc": "2.0", "id": 1, "method": "initialize", "params": {
        "protocolVersion": "2025-06-18", "capabilities": {},
        "clientInfo": {"name": "butler-e2e", "version": "0"}}});
    writeln!(stdin, "{initialize}")?;
    mcp_reply(&replies, 1, Duration::from_secs(30))?;
    writeln!(
        stdin,
        "{}",
        json!({"jsonrpc": "2.0", "method": "notifications/initialized"})
    )?;
    let call = json!({"jsonrpc": "2.0", "id": 2, "method": "tools/call",
        "params": {"name": tool, "arguments": {}}});
    writeln!(stdin, "{call}")?;
    let reply = mcp_reply(&replies, 2, Duration::from_secs(150));
    drop(stdin);
    let deadline = Instant::now() + Duration::from_secs(10);
    while child.try_wait()?.is_none() && Instant::now() < deadline {
        std::thread::sleep(Duration::from_millis(50));
    }
    if child.try_wait()?.is_none() {
        child.kill()?;
        child.wait()?;
    }
    reply
}

fn mcp_reply(
    replies: &mpsc::Receiver<String>,
    id: u64,
    within: Duration,
) -> Result<Value, HarnessError> {
    let deadline = Instant::now() + within;
    loop {
        let left = deadline.saturating_duration_since(Instant::now());
        let line = replies
            .recv_timeout(left)
            .map_err(|_| harness_error(format!("no MCP reply {id} within {within:?}")))?;
        let Ok(message) = serde_json::from_str::<Value>(&line) else {
            continue;
        };
        if message["id"] == id {
            return Ok(message);
        }
    }
}
