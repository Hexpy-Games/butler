//! Transport value normalization shared by non-final projections.

use crate::public_text::fixed_regex;
use regex::Regex;
use rusqlite::{Connection, OptionalExtension, params};
use serde_json::{Map, Value};
use std::sync::LazyLock;

use crate::gateway::application::storage::AppStorageError;

use super::ProjectionOutcome;

pub(super) fn worker_result(m: &Map<String, Value>) -> bool {
    m.get("kind").and_then(Value::as_str) == Some("worker_result")
        || m.get("type").and_then(Value::as_str) == Some("worker-result")
}
pub(super) fn object(value: Option<&Value>) -> &Map<String, Value> {
    static EMPTY: std::sync::LazyLock<Map<String, Value>> = std::sync::LazyLock::new(Map::new);
    value.and_then(Value::as_object).unwrap_or(&EMPTY)
}
pub(super) fn text(v: Option<&Value>) -> Option<String> {
    v.and_then(Value::as_str)
        .map(crate::public_text::trim_js_whitespace)
        .filter(|s| !s.is_empty())
        .map(str::to_owned)
}
pub(super) fn token(v: Option<&Value>) -> Option<String> {
    text(v)
        .map(|v| {
            v.chars()
                .filter(|c| c.is_alphanumeric() || "_:./-".contains(*c))
                .collect::<String>()
        })
        .filter(|v| !v.is_empty())
        .map(|v| v.chars().take(96).collect())
}
pub(super) fn short_text(v: &str, limit: usize) -> String {
    public_text(v).chars().take(limit).collect()
}
pub(super) fn copy_string(
    source: &Map<String, Value>,
    target: &mut Map<String, Value>,
    from: &str,
    to: &str,
    limit: usize,
) {
    if let Some(v) = text(source.get(from)) {
        target.insert(to.into(), short_text(&v, limit).into());
    }
}

fn public_text(value: &str) -> String {
    static SECRET: LazyLock<Regex> =
        LazyLock::new(|| fixed_regex(r"(?iu)\b(?:api[_-]?key|token|secret|password)\s*[:=]\s*\S+"));
    let stripped = value
        .chars()
        .map(|character| {
            if character < '\u{20}' || character == '\u{7f}' {
                ' '
            } else {
                character
            }
        })
        .collect::<String>();
    let redacted = SECRET.replace_all(&stripped, "[redacted]");
    let mut output = String::with_capacity(redacted.len());
    let mut space = false;
    for character in redacted.chars() {
        if js_whitespace(character) {
            space = !output.is_empty();
            continue;
        }
        if space {
            output.push(' ');
            space = false;
        }
        output.push(character);
    }
    output
}

fn js_whitespace(character: char) -> bool {
    matches!(character,'\u{9}'..='\u{d}'|'\u{20}'|'\u{a0}'|'\u{1680}'|'\u{2000}'..='\u{200a}'|'\u{2028}'|'\u{2029}'|'\u{202f}'|'\u{205f}'|'\u{3000}'|'\u{feff}')
}
pub(super) fn not_handled() -> ProjectionOutcome {
    ProjectionOutcome {
        handled: false,
        wake_queue: false,
        terminal_turn: None,
    }
}

pub(super) fn turn_id(
    db: &Connection,
    chat: &str,
    metadata: &Map<String, Value>,
    message: &Map<String, Value>,
) -> Result<Option<String>, AppStorageError> {
    if let Some(id) = token(metadata.get("turnId")) {
        return Ok(Some(id));
    }
    let Some(reply) = text(message.get("replyToMessageId")) else {
        return Ok(None);
    };
    db.query_row(
        "SELECT id FROM turns WHERE chat_id=?1 AND user_message_id=?2 ORDER BY rowid DESC LIMIT 1",
        params![chat, reply],
        |r| r.get(0),
    )
    .optional()
    .map_err(AppStorageError::sqlite)
}
