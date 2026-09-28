//! Observing the Agent's stop intent and instance record in `D/state`, and
//! the controllers the lifecycle scenarios run (`butler stop`, MCP
//! `restart_butler` over stdio).

use std::io::{BufRead, BufReader, Write};
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::mpsc;
use std::time::{Duration, Instant};

use serde_json::{Value, json};

use super::agent::Launch;
use super::{HarnessError, harness_error};

/// Where a controller announces an intentional stop.
pub fn intent_path(data: &Path) -> PathBuf {
    data.join("state/agent-stop-intent.json")
}

fn read_json(path: &Path) -> Option<Value> {
    std::fs::read(path)
        .ok()
        .and_then(|bytes| serde_json::from_slice(&bytes).ok())
}

/// The stop intent, when there is one.
pub fn read_intent(data: &Path) -> Option<Value> {
    read_json(&intent_path(data))
}

/// The Agent's instance record, when there is one.
pub fn instance_record(data: &Path) -> Option<Value> {
    read_json(&data.join("state/butler-agent-native-service.json"))
}

/// What a watcher of `D/state` sees while a restart runs.
#[derive(Default)]
pub struct RestartWatch {
    /// The first intent seen and when.
    pub intent: Option<(Value, Duration)>,
    /// When an instance with another nonce was first seen ready.
    pub ready: Option<Duration>,
}

impl RestartWatch {
    pub fn observe(&mut self, data: &Path, old_nonce: &Value, started: Instant) {
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

/// Stops whatever service instance owns the data dir when dropped, so a
/// failed assertion does not leave the detached service a restart started.
/// Dropped explicitly before `Scenario::finish` removes the data dir.
pub struct StopOnDrop(pub Launch);

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
pub fn mcp_tool_call(mut command: Command, log: &Path, tool: &str) -> Result<Value, HarnessError> {
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
