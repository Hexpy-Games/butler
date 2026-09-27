//! Intentional-stop signal for App supervisors: `state/agent-stop-intent.json`.
//!
//! A controller that stops the instance on purpose (`butler stop`, `butler
//! restart`, MCP `restart_butler`, the service-owned restart handoff) writes
//! this file atomically before it signals the process. A supervisor that sees
//! the process exit reads it to tell an intended stop from a crash. The next
//! instance removes it, whatever it says, when it reaches `ready`.

use std::fs::{self, OpenOptions};
use std::io::{self, Write};
use std::os::unix::fs::{DirBuilderExt, OpenOptionsExt};
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

use super::InstanceRecord;

/// Wire schema of the stop-intent file.
pub(crate) const STOP_INTENT_SCHEMA: &str = "butler.agent-stop-intent.v1";

/// Why the instance is being stopped.
#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "lowercase")]
pub(crate) enum StopReason {
    /// The instance stays stopped until a controller starts one again.
    Stop,
    /// The controller starts a new instance right after this one exits.
    Restart,
}

/// The controller that asked for the stop.
#[derive(Clone, Copy, Debug, Default, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "lowercase")]
pub(crate) enum StopRequester {
    /// The `butler` command line, including the detached restart helper.
    #[default]
    Cli,
    /// The Butler App.
    App,
    /// The `butler mcp serve` stdio server.
    Mcp,
}

impl StopRequester {
    /// Parses the `--requested-by` option value.
    pub(crate) fn parse(value: &str) -> Option<Self> {
        match value {
            "cli" => Some(Self::Cli),
            "app" => Some(Self::App),
            "mcp" => Some(Self::Mcp),
            _ => None,
        }
    }

    /// The option and wire spelling.
    pub(crate) fn as_str(self) -> &'static str {
        match self {
            Self::Cli => "cli",
            Self::App => "app",
            Self::Mcp => "mcp",
        }
    }
}

/// What a controller asks for when it stops the instance.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) struct StopRequest {
    /// Why the instance stops.
    pub(crate) reason: StopReason,
    /// Who asked.
    pub(crate) requested_by: StopRequester,
}

/// The persisted intent (`butler.agent-stop-intent.v1`).
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub(crate) struct StopIntent {
    schema: String,
    /// Why the instance stops.
    pub(crate) reason: StopReason,
    /// Who asked.
    pub(crate) requested_by: StopRequester,
    /// The nonce of the instance record being stopped.
    pub(crate) instance_id: String,
    /// The PID of the instance being stopped.
    pub(crate) pid: u32,
    /// RFC 3339 UTC time the controller wrote the intent.
    pub(crate) requested_at: String,
}

impl StopIntent {
    /// The intent to stop the instance `record` describes, stamped now.
    pub(crate) fn new(request: StopRequest, record: &InstanceRecord) -> Self {
        Self {
            schema: STOP_INTENT_SCHEMA.to_owned(),
            reason: request.reason,
            requested_by: request.requested_by,
            instance_id: record.nonce.clone(),
            pid: record.pid,
            requested_at: chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true),
        }
    }
}

/// A stop-intent file operation that failed.
#[derive(Debug, thiserror::Error)]
pub(crate) enum StopIntentError {
    /// The state directory could not be created.
    #[error("agent_stop_intent_unavailable: state directory could not be prepared")]
    Directory(#[source] io::Error),
    /// The intent could not be serialized.
    #[error("agent_stop_intent_unavailable: intent could not be encoded")]
    Encode(#[source] serde_json::Error),
    /// The temporary file could not be written or renamed into place.
    #[error("agent_stop_intent_unavailable: intent could not be written")]
    Write(#[source] io::Error),
    /// The intent could not be read back.
    #[error("agent_stop_intent_unavailable: intent could not be read")]
    Read(#[source] io::Error),
    /// The intent could not be removed.
    #[error("agent_stop_intent_unavailable: intent could not be removed")]
    Remove(#[source] io::Error),
}

/// Where the intent lives under DATA.
pub(crate) fn stop_intent_path(data_root: &Path) -> PathBuf {
    data_root.join("state/agent-stop-intent.json")
}

/// Writes `intent` with a temporary file and a rename, so a reader sees the
/// previous file or the complete new one, never a partial write.
pub(crate) fn write_stop_intent(
    data_root: &Path,
    intent: &StopIntent,
) -> Result<(), StopIntentError> {
    let path = stop_intent_path(data_root);
    if let Some(parent) = path.parent() {
        fs::DirBuilder::new()
            .recursive(true)
            .mode(0o700)
            .create(parent)
            .map_err(StopIntentError::Directory)?;
    }
    let mut bytes = serde_json::to_vec_pretty(intent).map_err(StopIntentError::Encode)?;
    bytes.push(b'\n');
    let temporary = path.with_extension(format!("json.{}.tmp", uuid::Uuid::new_v4()));
    let written = write_new_file(&temporary, &bytes).and_then(|()| fs::rename(&temporary, &path));
    if written.is_err() {
        let _ = fs::remove_file(&temporary);
    }
    written.map_err(StopIntentError::Write)
}

/// Removes the intent whatever it says; a missing file is already clear.
pub(crate) fn clear_stop_intent(data_root: &Path) -> Result<(), StopIntentError> {
    match fs::remove_file(stop_intent_path(data_root)) {
        Ok(()) => Ok(()),
        Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(()),
        Err(error) => Err(StopIntentError::Remove(error)),
    }
}

/// Removes the intent only while it still names `instance_id`: the signal it
/// announced was never delivered, so that instance's next exit is not intended.
pub(crate) fn withdraw_stop_intent(
    data_root: &Path,
    instance_id: &str,
) -> Result<(), StopIntentError> {
    let path = stop_intent_path(data_root);
    let bytes = match fs::read(&path) {
        Ok(bytes) => bytes,
        Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(()),
        Err(error) => return Err(StopIntentError::Read(error)),
    };
    let names_instance = serde_json::from_slice::<StopIntent>(&bytes)
        .is_ok_and(|intent| intent.instance_id == instance_id);
    if names_instance {
        clear_stop_intent(data_root)?;
    }
    Ok(())
}

fn write_new_file(path: &Path, bytes: &[u8]) -> io::Result<()> {
    let mut file = OpenOptions::new()
        .write(true)
        .create_new(true)
        .mode(0o600)
        .open(path)?;
    file.write_all(bytes)?;
    file.sync_all()
}

#[cfg(test)]
mod tests {
    use super::{STOP_INTENT_SCHEMA, StopIntent, StopReason, StopRequester};

    /// Pins the wire format the App supervisor parses.
    #[test]
    fn stop_intent_wire_format_is_pinned() {
        let intent = StopIntent {
            schema: STOP_INTENT_SCHEMA.to_owned(),
            reason: StopReason::Restart,
            requested_by: StopRequester::Mcp,
            instance_id: "3f1c9a52-4a0e-4a8e-9a57-0d9a3e1f7b21".to_owned(),
            pid: 4242,
            requested_at: "2026-09-28T01:02:03.456Z".to_owned(),
        };
        assert_eq!(
            serde_json::to_value(&intent).unwrap(),
            serde_json::json!({
                "schema": "butler.agent-stop-intent.v1",
                "reason": "restart",
                "requested_by": "mcp",
                "instance_id": "3f1c9a52-4a0e-4a8e-9a57-0d9a3e1f7b21",
                "pid": 4242,
                "requested_at": "2026-09-28T01:02:03.456Z",
            })
        );
        for requester in [StopRequester::Cli, StopRequester::App, StopRequester::Mcp] {
            assert_eq!(StopRequester::parse(requester.as_str()), Some(requester));
        }
        assert_eq!(StopRequester::parse("launchd"), None);
    }
}
