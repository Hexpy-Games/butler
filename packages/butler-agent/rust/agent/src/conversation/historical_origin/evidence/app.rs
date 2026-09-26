use std::path::Path;

use rusqlite::{Connection, OpenFlags, OptionalExtension, params};
use serde_json::{Value, json};

use super::{ConversationOriginEvidence, HistoricalOriginCandidate, SourceEvidence, sha256};
use crate::public_text::trim_js_whitespace;

pub(super) fn read(data_root: &Path, row: &HistoricalOriginCandidate) -> SourceEvidence {
    let path = data_root.join("app-server/butler-client.sqlite");
    if !path.exists() {
        return SourceEvidence::absent();
    }
    read_existing(&path, row).unwrap_or_else(SourceEvidence::unavailable)
}

fn read_existing(path: &Path, candidate: &HistoricalOriginCandidate) -> Option<SourceEvidence> {
    let db = Connection::open_with_flags(path, OpenFlags::SQLITE_OPEN_READ_ONLY).ok()?;
    let has_table: bool = db
        .query_row(
            "SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE type='table' AND name='messages')",
            [],
            |row| row.get(0),
        )
        .ok()?;
    if !has_table {
        return None;
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
            return None;
        }
    }
    type AppRow = (
        String,
        String,
        String,
        Option<String>,
        Option<String>,
        Option<String>,
        Option<String>,
        Option<String>,
    );
    let row: Option<AppRow> = db.query_row(
        "SELECT m.id,m.chat_id,m.role,m.conversation_session_id,m.conversation_turn_id,m.conversation_message_id,t.id app_turn_id,t.execution_controls_json \
         FROM messages m LEFT JOIN turns t ON t.chat_id=m.chat_id AND t.user_message_id=m.id \
         WHERE m.conversation_session_id=?1 AND m.conversation_turn_id IS ?2 AND m.conversation_message_id=?3 \
         ORDER BY m.created_at,m.id LIMIT 1",
        params![candidate.session_id, candidate.turn_id, candidate.message_id],
        |r| Ok((r.get(0)?,r.get(1)?,r.get(2)?,r.get(3)?,r.get(4)?,r.get(5)?,r.get(6)?,r.get(7)?)),
    ).optional().ok()?;
    let Some((id, chat, role, session, turn, message, app_turn, controls_json)) = row else {
        return Some(SourceEvidence::absent());
    };
    let matched = role == "user"
        && session.as_deref() == Some(&candidate.session_id)
        && turn == candidate.turn_id
        && message.as_deref() == Some(&candidate.message_id)
        && app_turn.is_some()
        && controls_json.is_some()
        && candidate
            .external_session_id
            .as_ref()
            .is_none_or(|external| session_hint(&chat) == *external);
    let mut internal_control = false;
    if let Some(raw) = &controls_json {
        let controls: Value = serde_json::from_str(raw).ok()?;
        super::queue::controls_valid(&controls).ok()?;
        if controls["turn_id"].as_str() != app_turn.as_deref()
            || controls["session_id"].as_str() != Some(&chat)
        {
            return None;
        }
        internal_control = super::truthy(&controls["subsession_result"]);
    }
    let value = json!({"id":id,"chat_id":chat,"role":role,
        "conversation_session_id":session,"conversation_turn_id":turn,
        "conversation_message_id":message,"app_turn_id":app_turn,
        "execution_controls_json":controls_json});
    let json = crate::json::stringify(&value).ok()?;
    Some(SourceEvidence {
        available: true,
        matched,
        public_ingress: false,
        internal_control,
        evidence: if matched {
            vec![ConversationOriginEvidence {
                kind: "app_ingress".into(),
                reference: id,
                sha256: Some(sha256(json)),
            }]
        } else {
            Vec::new()
        },
    })
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
