//! Resolve the same stored/configured preference as the settings projection.
use rusqlite::Connection;
use serde_json::Value;

use super::{AppSettingsFacts, AppStorageError, SETTINGS_KEY, read_json};

/// Called on the storage worker because resolving the system zone may use I/O.
pub(in crate::gateway::application) fn effective_timezone(
    db: &Connection,
    facts: &AppSettingsFacts,
) -> Result<String, AppStorageError> {
    let stored = read_json(db, SETTINGS_KEY)?.unwrap_or(Value::Null);
    let native = &facts.native_settings;
    let configured = stored
        .get("timezone")
        .or_else(|| native["config_user"].get("timezone"))
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|zone| !zone.is_empty());
    let zone = configured.filter(|zone| *zone != "local").or_else(|| {
        native["local_timezone"]
            .as_str()
            .filter(|zone| !zone.is_empty() && *zone != "local")
    });
    Ok(zone.map(str::to_owned).unwrap_or_else(|| {
        butler_platform::instance::system_time_zone_name().unwrap_or_else(|_| "UTC".into())
    }))
}
