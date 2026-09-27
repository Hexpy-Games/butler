use std::path::Path;

use rusqlite::{Connection, OpenFlags, OptionalExtension, params};
use serde_json::{Value, json};

use super::{ConversationOriginEvidence, HistoricalOriginCandidate, SourceEvidence, sha256};
use butler_core::public_text::trim_js_whitespace;

pub(super) fn read(data_root: &Path, row: &HistoricalOriginCandidate) -> SourceEvidence {
    let path = data_root.join("app-server/butler-client.sqlite");
    if !path.exists() {
        return SourceEvidence::absent();
    }
    read_existing(&path, row).unwrap_or_else(SourceEvidence::unavailable)
}

/// One App message row and its App turn.
struct AppMessage {
    id: String,
    chat: String,
    role: String,
    session: Option<String>,
    turn: Option<String>,
    message: Option<String>,
    app_turn: Option<String>,
    controls_json: Option<String>,
}

/// App ingress evidence: the App message bound to the candidate, with its
/// turn's execution controls. `None` means the evidence is unavailable.
fn read_existing(path: &Path, candidate: &HistoricalOriginCandidate) -> Option<SourceEvidence> {
    let db = Connection::open_with_flags(path, OpenFlags::SQLITE_OPEN_READ_ONLY).ok()?;
    if !has_conversation_columns(&db)? {
        return None;
    }
    let Some(row) = app_message(&db, candidate)? else {
        return Some(SourceEvidence::absent());
    };
    let matched = row.role == "user"
        && row.session.as_deref() == Some(&candidate.session_id)
        && row.turn == candidate.turn_id
        && row.message.as_deref() == Some(&candidate.message_id)
        && row.app_turn.is_some()
        && row.controls_json.is_some()
        && candidate
            .external_session_id
            .as_ref()
            .is_none_or(|external| session_hint(&row.chat) == *external);
    let internal_control = match &row.controls_json {
        Some(raw) => subsession_controls(raw, &row)?,
        None => false,
    };
    let value = json!({"id":row.id,"chat_id":row.chat,"role":row.role,
        "conversation_session_id":row.session,"conversation_turn_id":row.turn,
        "conversation_message_id":row.message,"app_turn_id":row.app_turn,
        "execution_controls_json":row.controls_json});
    let json = butler_core::json::stringify(&value).ok()?;
    Some(SourceEvidence {
        available: true,
        matched,
        public_ingress: false,
        internal_control,
        evidence: if matched {
            vec![ConversationOriginEvidence {
                kind: "app_ingress".into(),
                reference: row.id,
                sha256: Some(sha256(json)),
            }]
        } else {
            Vec::new()
        },
    })
}

/// Whether the App store has a messages table with conversation identities.
fn has_conversation_columns(db: &Connection) -> Option<bool> {
    let has_table: bool = db
        .query_row(
            "SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE type='table' AND name='messages')",
            [],
            |row| row.get(0),
        )
        .ok()?;
    if !has_table {
        return Some(false);
    }
    for column in [
        "conversation_session_id",
        "conversation_turn_id",
        "conversation_message_id",
    ] {
        let mut stmt = db.prepare("PRAGMA table_info(messages)").ok()?;
        let names = stmt.query_map([], |row| row.get::<_, String>(1)).ok()?;
        if !names
            .into_iter()
            .any(|name| name.ok().as_deref() == Some(column))
        {
            return Some(false);
        }
    }
    Some(true)
}

fn app_message(
    db: &Connection,
    candidate: &HistoricalOriginCandidate,
) -> Option<Option<AppMessage>> {
    db.query_row(
        "SELECT m.id,m.chat_id,m.role,m.conversation_session_id,m.conversation_turn_id,m.conversation_message_id,t.id app_turn_id,t.execution_controls_json \
         FROM messages m LEFT JOIN turns t ON t.chat_id=m.chat_id AND t.user_message_id=m.id \
         WHERE m.conversation_session_id=?1 AND m.conversation_turn_id IS ?2 AND m.conversation_message_id=?3 \
         ORDER BY m.created_at,m.id LIMIT 1",
        params![candidate.session_id, candidate.turn_id, candidate.message_id],
        |r| {
            Ok(AppMessage {
                id: r.get(0)?,
                chat: r.get(1)?,
                role: r.get(2)?,
                session: r.get(3)?,
                turn: r.get(4)?,
                message: r.get(5)?,
                app_turn: r.get(6)?,
                controls_json: r.get(7)?,
            })
        },
    )
    .optional()
    .ok()
}

/// Whether valid execution controls of the message's own App turn mark it a
/// subsession result; `None` when the controls are invalid or foreign.
fn subsession_controls(raw: &str, row: &AppMessage) -> Option<bool> {
    let controls: Value = serde_json::from_str(raw).ok()?;
    super::queue::controls_valid(&controls).ok()?;
    if controls["turn_id"].as_str() != row.app_turn.as_deref()
        || controls["session_id"].as_str() != Some(&row.chat)
    {
        return None;
    }
    Some(super::truthy(&controls["subsession_result"]))
}

fn session_hint(chat: &str) -> String {
    let mut normalized = String::new();
    let mut separator = false;
    for ch in trim_js_whitespace(chat).to_lowercase().chars() {
        if ch.is_ascii_lowercase() || ch.is_ascii_digit() || matches!(ch, '.' | '_' | '-') {
            normalized.push(ch);
            separator = false;
        } else if !separator {
            normalized.push('-');
            separator = true;
        }
    }
    format!(
        "butler/app-{}",
        if normalized.is_empty() {
            "session"
        } else {
            &normalized
        }
    )
}
