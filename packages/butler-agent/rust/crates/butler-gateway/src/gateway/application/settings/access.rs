//! The access mode an install resolves an unsaved mode to, and the access
//! mode a conversation runs with.

use rusqlite::{Connection, params};
use serde_json::Value;

use super::SETTINGS_KEY;
use super::persistence::{read_json, safe_local_session_id};
use super::storage_helpers::parse_access;
use crate::gateway::application::storage::AppStorageError;
use butler_turn::btcc::AccessMode;

/// The `app_settings` key holding the access mode this install resolves an
/// unsaved mode to. The App database migration records it once.
const DEFAULT_ACCESS_MODE_KEY: &str = "default-access-mode";

/// The access mode a new install runs with until the user saves one: ask
/// first (#236).
const NEW_INSTALL_ACCESS_MODE: AccessMode = AccessMode::AskFirst;

/// The access mode an install from before ask-first (#236) keeps until the
/// user saves one: full access, the default it has been running with. Saved
/// settings are not migrated (owner decision), so nothing changes for it.
const EXISTING_INSTALL_ACCESS_MODE: AccessMode = AccessMode::FullAccess;

/// Records, once, the access mode this install resolves an unsaved mode to:
/// full access when the App database existed before this release
/// (`existing_database`), ask first for a new one. A recorded mode is never
/// rewritten.
pub(in crate::gateway::application) fn record_default_access_mode(
    db: &Connection,
    existing_database: bool,
) -> Result<(), AppStorageError> {
    let mode = if existing_database {
        EXISTING_INSTALL_ACCESS_MODE
    } else {
        NEW_INSTALL_ACCESS_MODE
    };
    db.execute(
        "INSERT OR IGNORE INTO app_settings(key,value_json,updated_at) \
         VALUES(?1,?2,strftime('%Y-%m-%dT%H:%M:%fZ','now'))",
        params![
            DEFAULT_ACCESS_MODE_KEY,
            Value::from(access_mode_name(&mode)).to_string()
        ],
    )
    .map_err(AppStorageError::sqlite)?;
    Ok(())
}

/// The access mode this install resolves an unsaved mode to: the recorded
/// one, else (a database the migration has not seen) a new install's.
pub(in crate::gateway::application) fn default_access_mode(
    db: &Connection,
) -> Result<AccessMode, AppStorageError> {
    Ok(read_json(db, DEFAULT_ACCESS_MODE_KEY)?
        .as_ref()
        .and_then(Value::as_str)
        .and_then(parse_access)
        .unwrap_or(NEW_INSTALL_ACCESS_MODE))
}

/// The access mode conversation `chat_id` runs with: its explicit session
/// controls, else the saved global setting, else [`default_access_mode`].
/// Message sends, new schedules and the schedule backfill share this rule.
pub(in crate::gateway::application) fn conversation_access_mode(
    db: &Connection,
    chat_id: &str,
) -> Result<AccessMode, AppStorageError> {
    let key = safe_local_session_id(chat_id);
    let explicit = read_json(db, &format!("session-controls-explicit:{key}"))?
        .and_then(|value| value.as_bool())
        == Some(true);
    let session = if explicit {
        read_json(db, &format!("session-controls:{key}"))?
    } else {
        None
    };
    let global = read_json(db, SETTINGS_KEY)?;
    let saved = [session, global].iter().flatten().find_map(|stored| {
        stored
            .get("access_mode")
            .and_then(Value::as_str)
            .and_then(parse_access)
    });
    match saved {
        Some(mode) => Ok(mode),
        None => default_access_mode(db),
    }
}

/// The stored and wire name of `mode`.
pub(in crate::gateway::application) fn access_mode_name(mode: &AccessMode) -> &'static str {
    match mode {
        AccessMode::FullAccess => "full_access",
        AccessMode::AskFirst => "ask_first",
        AccessMode::ReadOnly => "read_only",
    }
}
