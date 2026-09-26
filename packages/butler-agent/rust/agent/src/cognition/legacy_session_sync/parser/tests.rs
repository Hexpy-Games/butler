
use super::parse_and_chunk;

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
