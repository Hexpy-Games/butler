use rusqlite::{Connection, OptionalExtension, params};
use serde_json::Value;

use crate::gateway::application::storage::AppStorageError;
use crate::public_text::trim_js_whitespace;

pub(super) fn revision(db: &Connection, key: &str) -> Result<u64, AppStorageError> {
    Ok(read_json(db, key)?
        .and_then(|value| {
            let number = value.as_f64()?;
            (number.is_finite()
                && number >= 0.0
                && number.fract() == 0.0
                && number <= 9_007_199_254_740_991.0)
                .then_some(number as u64)
        })
        .unwrap_or(0))
}

pub(super) fn read_json(db: &Connection, key: &str) -> Result<Option<Value>, AppStorageError> {
    let value = db
        .query_row(
            "SELECT value_json FROM app_settings WHERE key=?1",
            [key],
            |row| row.get::<_, String>(0),
        )
        .optional()
        .map_err(AppStorageError::sqlite)?;
    Ok(value.and_then(|value| serde_json::from_str(&value).ok()))
}

pub(super) fn write_json(
    db: &Connection,
    key: &str,
    value: &Value,
    now: &str,
) -> Result<(), AppStorageError> {
    let encoded = serde_json::to_string(value)
        .map_err(|error| AppStorageError::new("settings_json_failed", error.to_string()))?;
    db.execute(
        "INSERT INTO app_settings(key,value_json,updated_at) VALUES(?1,?2,?3) \
         ON CONFLICT(key) DO UPDATE SET value_json=excluded.value_json,updated_at=excluded.updated_at",
        params![key, encoded, now],
    )
    .map_err(AppStorageError::sqlite)?;
    Ok(())
}

pub(super) fn safe_local_session_id(value: &str) -> String {
    let mut output = String::new();
    let mut separator = false;
    for byte in trim_js_whitespace(value).bytes() {
        let byte = byte.to_ascii_lowercase();
        if byte.is_ascii_alphanumeric() || matches!(byte, b'.' | b'_' | b'-') {
            output.push(byte as char);
            separator = false;
        } else if !separator {
            output.push('-');
            separator = true;
        }
    }
    if output.is_empty() {
        "session".into()
    } else {
        output
    }
}
