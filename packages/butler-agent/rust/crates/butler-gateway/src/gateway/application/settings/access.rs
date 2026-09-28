//! The default access mode and the access mode stored for a conversation.

use rusqlite::Connection;
use serde_json::Value;

use super::SETTINGS_KEY;
use super::persistence::{read_json, safe_local_session_id};
use super::storage_helpers::parse_access;
use crate::gateway::application::storage::AppStorageError;
use butler_turn::btcc::AccessMode;

/// The access mode of a conversation with none stored, and of the global
/// setting until the user picks one: ask first (#236). An install that never
/// saved a mode gets it too; a saved mode is kept.
pub(in crate::gateway::application) const DEFAULT_ACCESS_MODE: AccessMode = AccessMode::AskFirst;

/// The access mode conversation `chat_id` runs with: its explicit session
/// controls, else the stored global setting, else [`DEFAULT_ACCESS_MODE`].
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
    Ok([session, global]
        .iter()
        .flatten()
        .find_map(|stored| {
            stored
                .get("access_mode")
                .and_then(Value::as_str)
                .and_then(parse_access)
        })
        .unwrap_or(DEFAULT_ACCESS_MODE))
}

/// The stored and wire name of `mode`.
pub(in crate::gateway::application) fn access_mode_name(mode: &AccessMode) -> &'static str {
    match mode {
        AccessMode::FullAccess => "full_access",
        AccessMode::AskFirst => "ask_first",
        AccessMode::ReadOnly => "read_only",
    }
}
