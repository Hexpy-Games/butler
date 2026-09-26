use serde_json::{Value, json};

use super::session_id::normalize_session_id_for_storage;

const CHUNK_GAP_MS: i64 = 30 * 60 * 1000;
const HOT_CONVERSATION_PREFIX_UTF16_LIMIT: usize = 8000;

#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub(super) struct ParsedTranscript {
    pub(super) message_count: usize,
    pub(super) chunks: Vec<ParsedChunk>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct ParsedChunk {
    pub(crate) storage_id: String,
    pub(crate) original_id: String,
    pub(crate) conversation_text: String,
    pub(crate) index_text: String,
    pub(crate) index_jsonl: String,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Role {
    Human,
    Assistant,
}

impl Role {
    fn rendered_name(self) -> &'static str {
        match self {
            Self::Human => "user",
            Self::Assistant => "butler",
        }
    }
}

#[derive(Clone, Debug)]
struct Message {
    role: Role,
    text: String,
    timestamp: String,
    timestamp_ms: Option<i64>,
}

pub(super) fn parse_and_chunk(lines: &[String], fallback_session_id: &str) -> ParsedTranscript {
    let mut source_session_id = None;
    let mut messages: Vec<Message> = Vec::new();

    for line in lines {
        let Ok(value) = serde_json::from_str::<Value>(line) else {
            continue;
        };
        let Some(event) = transcript_event(&value) else {
            continue;
        };
        if source_session_id.is_none() {
            source_session_id = Some(event.session_id.to_owned());
        }

        let (role, text) = match event.kind {
            "inbound" => (Role::Human, nested_message_text(event.payload)),
            "outbound" => (Role::Assistant, nested_message_text(event.payload)),
            "turn" => (
                Role::Assistant,
                event.payload.get("text").and_then(Value::as_str),
            ),
            _ => continue,
        };
        let Some(text) = text else { continue };
        append_message(&mut messages, role, text, event.timestamp);
    }

    let message_count = messages.len();
    if messages.is_empty() {
        return ParsedTranscript {
            message_count,
            chunks: Vec::new(),
        };
    }

    let source_session_id = source_session_id.unwrap_or_else(|| fallback_session_id.to_owned());
    let mut groups: Vec<Vec<Message>> = Vec::new();
    for message in messages {
        let split = groups
            .last()
            .and_then(|group| group.last())
            .and_then(
                |previous| match (previous.timestamp_ms, message.timestamp_ms) {
                    (Some(previous), Some(current)) => Some(current - previous > CHUNK_GAP_MS),
                    _ => None,
                },
            )
            .unwrap_or(false);
        if groups.is_empty() || split {
            groups.push(Vec::new());
        }
        groups
            .last_mut()
            .expect("a group was just created")
            .push(message);
    }

    let normalized_id = normalize_session_id_for_storage(&source_session_id);
    let chunks = groups
        .into_iter()
        .enumerate()
        .map(|(index, group)| {
            let conversation_text = render_conversation(&group);
            let index_text = group
                .iter()
                .map(|message| message.text.as_str())
                .collect::<Vec<_>>()
                .join("\n\n");
            let index_jsonl = group.iter().map(index_line).collect::<Vec<_>>().join("\n");
            ParsedChunk {
                storage_id: format!("{normalized_id}_c{index}"),
                original_id: source_session_id.clone(),
                conversation_text,
                index_text,
                index_jsonl,
            }
        })
        .collect();

    ParsedTranscript {
        message_count,
        chunks,
    }
}

struct TranscriptEvent<'a> {
    session_id: &'a str,
    kind: &'a str,
    timestamp: &'a str,
    payload: &'a Value,
}

fn transcript_event(value: &Value) -> Option<TranscriptEvent<'_>> {
    let object = value.as_object()?;
    object.get("eventId")?.as_str()?;
    let session_id = object.get("sessionId")?.as_str()?;
    let kind = object.get("kind")?.as_str()?;
    let timestamp = object.get("timestamp")?.as_str()?;
    let payload = object.get("payload")?;
    if !(payload.is_object() || payload.is_array()) {
        return None;
    }
    Some(TranscriptEvent {
        session_id,
        kind,
        timestamp,
        payload,
    })
}

fn nested_message_text(payload: &Value) -> Option<&str> {
    payload.get("message")?.as_object()?.get("text")?.as_str()
}

fn append_message(messages: &mut Vec<Message>, role: Role, text: &str, timestamp: &str) {
    let text = js_trim(text);
    if text.is_empty() {
        return;
    }
    if messages
        .last()
        .is_some_and(|last| last.role == role && last.text == text)
    {
        return;
    }
    messages.push(Message {
        role,
        text,
        timestamp: timestamp.to_owned(),
        timestamp_ms: crate::js_date::parse_iso_millis(timestamp),
    });
}

fn js_trim(value: &str) -> String {
    value
        .trim_matches(|character: char| {
            matches!(
                character,
                '\u{0009}'..='\u{000d}'
                    | ' '
                    | '\u{00a0}'
                    | '\u{1680}'
                    | '\u{2000}'..='\u{200a}'
                    | '\u{2028}'
                    | '\u{2029}'
                    | '\u{202f}'
                    | '\u{205f}'
                    | '\u{3000}'
                    | '\u{feff}'
            )
        })
        .to_owned()
}

fn render_conversation(messages: &[Message]) -> String {
    messages
        .iter()
        .map(|message| format!("{}: {}", message.role.rendered_name(), message.text))
        .collect::<Vec<_>>()
        .join("\n\n")
}

fn index_line(message: &Message) -> String {
    let value = match message.role {
        Role::Assistant => json!({
            "type": "assistant",
            "timestamp": message.timestamp,
            "message": {
                "role": "assistant",
                "content": [{"type": "text", "text": message.text}],
            },
        }),
        Role::Human => json!({
            "type": "user",
            "timestamp": message.timestamp,
            "message": {
                "role": "user",
                "content": message.text,
            },
        }),
    };
    serde_json::to_string(&value).expect("serializing a JSON value cannot fail")
}

pub(super) fn prefix_utf16_8000(value: &str) -> String {
    prefix_utf16(value, HOT_CONVERSATION_PREFIX_UTF16_LIMIT)
}

fn prefix_utf16(value: &str, limit: usize) -> String {
    let units = value.encode_utf16().take(limit).collect::<Vec<_>>();
    String::from_utf16_lossy(&units)
}

#[cfg(test)]
mod tests {
    use super::{parse_and_chunk, prefix_utf16_8000};

    fn event(kind: &str, timestamp: &str, payload: serde_json::Value) -> String {
        serde_json::json!({
            "eventId": format!("event-{kind}-{timestamp}"),
            "sessionId": "session/source",
            "kind": kind,
            "timestamp": timestamp,
            "payload": payload,
        })
        .to_string()
    }

    #[test]
    fn parses_deduplicates_and_chunks_transcript_events() {
        let lines = vec![
            event(
                "inbound",
                "2025-01-01T00:00:00.000Z",
                serde_json::json!({"message":{"text":" hello "}}),
            ),
            event(
                "inbound",
                "2025-01-01T00:01:00.000Z",
                serde_json::json!({"message":{"text":"hello"}}),
            ),
            event(
                "turn",
                "2025-01-01T00:30:00.000Z",
                serde_json::json!({"text":"reply"}),
            ),
            event(
                "outbound",
                "2025-01-01T01:00:00.001Z",
                serde_json::json!({"message":{"text":"later"}}),
            ),
            "not-json".to_owned(),
        ];

        let parsed = parse_and_chunk(&lines, "fallback");
        assert_eq!(parsed.message_count, 3);
        assert_eq!(parsed.chunks.len(), 2);
        assert_eq!(parsed.chunks[0].storage_id, "session_source_c0");
        assert_eq!(parsed.chunks[0].original_id, "session/source");
        assert_eq!(
            parsed.chunks[0].conversation_text,
            "user: hello\n\nbutler: reply"
        );
        assert_eq!(parsed.chunks[0].index_text, "hello\n\nreply");
        assert_eq!(parsed.chunks[1].conversation_text, "butler: later");
        let index: Vec<serde_json::Value> = parsed.chunks[0]
            .index_jsonl
            .lines()
            .map(|line| serde_json::from_str(line).unwrap())
            .collect();
        assert_eq!(index[0]["type"], "user");
        assert_eq!(index[1]["message"]["content"][0]["text"], "reply");
    }

    #[test]
    fn utf16_prefix_keeps_javascript_slice_boundary() {
        let value = format!("{}🐈tail", "a".repeat(7999));
        let prefix = prefix_utf16_8000(&value);
        assert_eq!(prefix.encode_utf16().count(), 8000);
        assert!(prefix.ends_with('\u{fffd}'));
        assert_eq!(prefix_utf16_8000("short"), "short");
    }
}
