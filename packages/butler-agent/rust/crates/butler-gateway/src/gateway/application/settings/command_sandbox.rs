//! App-owned command preference, read at admission without scanning owner data.
use std::path::PathBuf;

use butler_platform::{command_sandbox, sqlite};
use rusqlite::{OpenFlags, OptionalExtension};
use serde_json::{Map, Value, json};

pub(super) fn project(stored: &Map<String, Value>, output: &mut Map<String, Value>) {
    output.insert(
        "command_sandbox_enabled".into(),
        json!(
            stored
                .get("command_sandbox_enabled")
                .and_then(Value::as_bool)
                .unwrap_or(true)
        ),
    );
    // Unknown availability stays false while the runtime warms the probe.
    // Never start or wait for a probe on the settings storage reader.
    output.insert(
        "command_sandbox_available".into(),
        json!(
            command_sandbox::cached_capabilities()
                .is_some_and(command_sandbox::SandboxCapabilities::project_write_available)
        ),
    );
}

/// Query the indexed settings key on a blocking worker. A missing preference
/// defaults on; an unreadable database fails closed at the caller.
pub async fn command_sandbox_enabled(
    path: PathBuf,
) -> Result<bool, crate::gateway::GatewayApplicationError> {
    tokio::task::spawn_blocking(move || {
        let db = sqlite::open_with_flags(path, OpenFlags::SQLITE_OPEN_READ_ONLY)?;
        db.busy_timeout(std::time::Duration::from_secs(5))?;
        let enabled: Option<Option<bool>> = db.query_row(
            "SELECT json_extract(value_json, '$.command_sandbox_enabled') FROM app_settings WHERE key='settings'",
            [], |row| row.get(0),
        ).optional()?;
        Ok::<_, rusqlite::Error>(enabled.flatten().unwrap_or(true))
    }).await.map_err(crate::gateway::GatewayApplicationError::internal_from)?
        .map_err(crate::gateway::GatewayApplicationError::internal_from)
}
