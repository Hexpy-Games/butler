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
    // This is host availability, independent of the user's switch. The cached
    // host probe also respects the Windows environment kill switch.
    output.insert(
        "command_sandbox_available".into(),
        json!(command_sandbox::project_write_available()),
    );
}

/// Query the indexed settings key on a blocking worker. A missing preference
/// defaults on; an unreadable database fails closed at the caller.
pub async fn command_sandbox_enabled(
    path: PathBuf,
) -> Result<bool, crate::gateway::GatewayApplicationError> {
    tokio::task::spawn_blocking(move || {
        let db = sqlite::open_with_flags(path, OpenFlags::SQLITE_OPEN_READ_ONLY)?;
        let enabled: Option<Option<bool>> = db.query_row(
            "SELECT json_extract(value_json, '$.command_sandbox_enabled') FROM app_settings WHERE key='settings'",
            [], |row| row.get(0),
        ).optional()?;
        Ok::<_, rusqlite::Error>(enabled.flatten().unwrap_or(true))
    }).await.map_err(crate::gateway::GatewayApplicationError::internal_from)?
        .map_err(crate::gateway::GatewayApplicationError::internal_from)
}
