//! The files the Agent and its controllers share (`app-agent-stop-intent.mjs`): the stop intent
//! (`state/agent-stop-intent.json`, `butler.agent-stop-intent.v1`) and the instance record
//! (`state/butler-agent-native-service.json`).

use std::fs;
use std::io::{self, Write};
use std::path::{Path, PathBuf};

use butler_platform::secure_fs;
use chrono::{DateTime, SecondsFormat, Utc};
use serde_json::{Value, json};
use url::Url;

const INTENT_SCHEMA: &str = "butler.agent-stop-intent.v1";
const INSTANCE_SCHEMA: &str = "butler.native-agent-service-instance.v1";
const REASONS: [&str; 2] = ["stop", "restart"];
const REQUESTERS: [&str; 3] = ["cli", "app", "mcp"];
const RESPAWNERS: [&str; 2] = ["app", "controller"];

/// A stop or restart announced before the Agent is signalled; fields as the file has them.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct StopIntent {
    /// `stop` or `restart`.
    pub(crate) reason: String,
    /// `cli`, `app` or `mcp`.
    pub(crate) requested_by: String,
    /// `app` or `controller`; none for a stop.
    pub(crate) respawn_by: Option<String>,
    pub(crate) instance_id: String,
    pub(crate) pid: u32,
    pub(crate) requested_at: String,
}

fn intent_path(data: &Path) -> PathBuf {
    data.join("state").join("agent-stop-intent.json")
}

fn instance_path(data: &Path) -> PathBuf {
    data.join("state").join("butler-agent-native-service.json")
}

/// `new Date().toISOString()`: the `requested_at` a new intent carries.
pub(crate) fn timestamp() -> String {
    Utc::now().to_rfc3339_opts(SecondsFormat::Millis, true)
}

/// The JSON object in `text`, if it is one.
fn object(text: &str) -> Option<Value> {
    serde_json::from_str::<Value>(text)
        .ok()
        .filter(Value::is_object)
}

fn string<'a>(value: &'a Value, key: &str) -> Option<&'a str> {
    value.get(key)?.as_str()
}

fn non_empty<'a>(value: &'a Value, key: &str) -> Option<&'a str> {
    string(value, key).filter(|text| !text.trim().is_empty())
}

fn pid(value: &Value) -> Option<u32> {
    u32::try_from(value.get("pid")?.as_u64()?)
        .ok()
        .filter(|pid| *pid > 0)
}

/// `parseAgentStopIntent`: anything unknown or malformed is none (a crash), never an error.
fn parse_intent(value: &Value) -> Option<StopIntent> {
    if string(value, "schema")? != INTENT_SCHEMA {
        return None;
    }
    let reason = string(value, "reason").filter(|reason| REASONS.contains(reason))?;
    let requested_by = string(value, "requested_by").filter(|by| REQUESTERS.contains(by))?;
    let respawn_by = match value.get("respawn_by") {
        None | Some(Value::Null) => None,
        Some(other) => Some(other.as_str().filter(|by| RESPAWNERS.contains(by))?),
    };
    let requested_at = non_empty(value, "requested_at")?;
    DateTime::parse_from_rfc3339(requested_at).ok()?;
    Some(StopIntent {
        reason: reason.to_owned(),
        requested_by: requested_by.to_owned(),
        respawn_by: respawn_by.map(str::to_owned),
        instance_id: non_empty(value, "instance_id")?.to_owned(),
        pid: pid(value)?,
        requested_at: requested_at.to_owned(),
    })
}

pub(crate) fn read_intent(data: &Path) -> Option<StopIntent> {
    let text = fs::read_to_string(intent_path(data)).ok()?;
    parse_intent(&object(&text)?)
}

/// Writes the intent atomically, owner-only.
pub(crate) fn write_intent(data: &Path, intent: &StopIntent) -> io::Result<()> {
    let record = json!({
        "schema": INTENT_SCHEMA,
        "reason": intent.reason,
        "requested_by": intent.requested_by,
        "respawn_by": intent.respawn_by,
        "instance_id": intent.instance_id,
        "pid": intent.pid,
        "requested_at": intent.requested_at,
    });
    if parse_intent(&record).is_none() {
        return Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            "invalid Agent stop intent",
        ));
    }
    let path = intent_path(data);
    if let Some(folder) = path.parent() {
        secure_fs::create_private_dir_all(folder)?;
    }
    secure_fs::replace_private(&path, |file| writeln!(file, "{record}"), |error| error)
}

/// Removes the intent when it still names `pid` and `instance_id`.
pub(crate) fn retract_intent(data: &Path, pid: u32, instance_id: &str) -> bool {
    let Some(current) = read_intent(data) else {
        return false;
    };
    if current.instance_id != instance_id || current.pid != pid {
        return false;
    }
    match fs::remove_file(intent_path(data)) {
        Ok(()) => true,
        Err(error) => error.kind() == io::ErrorKind::NotFound,
    }
}

/// The running Agent's instance record.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct InstanceRecord {
    pub(crate) pid: u32,
    pub(crate) nonce: String,
    pub(crate) state: String,
    pub(crate) app_enabled: bool,
    pub(crate) app_supervised: bool,
    pub(crate) port: Option<u16>,
}

/// The port of a loopback `http` endpoint (`localEndpointPort`).
fn endpoint_port(value: &Value) -> Option<u16> {
    let url = Url::parse(non_empty(value, "app_endpoint")?).ok()?;
    let loopback = matches!(url.host_str(), Some("127.0.0.1" | "localhost"));
    (url.scheme() == "http" && loopback)
        .then(|| url.port_or_known_default())
        .flatten()
        .filter(|port| *port > 0)
}

/// `parseNativeServiceInstance` over `state/butler-agent-native-service.json`.
pub(crate) fn read_instance(data: &Path) -> Option<InstanceRecord> {
    let text = fs::read_to_string(instance_path(data)).ok()?;
    let value = object(&text)?;
    if string(&value, "schema")? != INSTANCE_SCHEMA {
        return None;
    }
    let flag = |key: &str| value.get(key).and_then(Value::as_bool) == Some(true);
    Some(InstanceRecord {
        pid: pid(&value)?,
        nonce: non_empty(&value, "nonce")?.to_owned(),
        state: string(&value, "state").unwrap_or("unknown").to_owned(),
        app_enabled: flag("app_enabled"),
        app_supervised: flag("app_supervised"),
        port: endpoint_port(&value),
    })
}
