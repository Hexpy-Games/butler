//! The default access mode and the access mode stored for a conversation.

use rusqlite::Connection;
use serde_json::Value;

use super::SETTINGS_KEY;
use super::persistence::{read_json, safe_local_session_id};
use super::storage_helpers::parse_access;
use crate::gateway::application::storage::AppStorageError;
use butler_turn::btcc::AccessMode;

/// The access mode of a conversation with none stored, and of the global
/// setting until the user picks one: ask first (#236).
pub(in crate::gateway::application) const DEFAULT_ACCESS_MODE: AccessMode = AccessMode::AskFirst;

/// The default before ask-first replaced it. Migrations that must not change
/// what existing data does resolve an unset mode to it.
pub(in crate::gateway::application) const PRE_ASK_FIRST_ACCESS_MODE: AccessMode =
    AccessMode::FullAccess;

/// The access mode conversation `chat_id` runs with: its explicit session
/// controls, else the stored global setting, else `default`.
pub(in crate::gateway::application) fn stored_session_access(
    db: &Connection,
    chat_id: &str,
    default: AccessMode,
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
    Ok([session, global]
        .iter()
        .flatten()
        .find_map(|stored| {
            stored
                .get("access_mode")
                .and_then(Value::as_str)
                .and_then(parse_access)
        })
        .unwrap_or(default))
}

/// The stored and wire name of `mode`.
pub(in crate::gateway::application) fn access_mode_name(mode: &AccessMode) -> &'static str {
    match mode {
        AccessMode::FullAccess => "full_access",
        AccessMode::AskFirst => "ask_first",
        AccessMode::ReadOnly => "read_only",
    }
}
