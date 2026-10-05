//! Publish every stream/runtime event with transaction-local sequence reuse.
use super::*;
pub(super) fn publish(
    input: RuntimeInput<'_>,
    source: &Map<String, Value>,
    kind: &str,
    normalized_payload: Map<String, Value>,
) -> Result<(), AppStorageError> {
    let RuntimeInput {
        db,
        subscribers,
        chat,
        turn,
        now,
        generated_id,
        ..
    } = input;
    let mut event = source.clone();
    let actual_event_id = token(event.get("id")).unwrap_or_else(|| generated_id.to_owned());
    event.insert("id".into(), actual_event_id.clone().into());
    event.insert("sessionId".into(), chat.into());
    event.insert("turnId".into(), turn.into());
    let session_next = next_sequence(db, "sessionId", chat)?;
    let turn_next = next_sequence(db, "turnId", turn)?;
    event.insert(
        "sessionSequence".into(),
        sequence(event.get("sessionSequence"), session_next).into(),
    );
    event.insert(
        "turnSequence".into(),
        sequence(event.get("turnSequence"), turn_next).into(),
    );
    event.entry("visibility").or_insert_with(|| "public".into());
    event.insert("payload".into(), Value::Object(normalized_payload));
    event
        .entry("createdAt")
        .or_insert_with(|| Value::String(now.to_owned()));
    let progress_row = row_from_runtime_event(
        kind,
        object(event.get("payload")),
        &actual_event_id,
        now,
        event.get("turnSequence").and_then(Value::as_u64),
    );
    events::append(
        db,
        subscribers,
        "agent.turn_event",
        Some(turn),
        service::map(&json!({
            "session_id": chat, "turn_id": turn, "event": event
        }))?,
        now,
    )?;
    batch::observe_event(chat, turn, &event);
    stream_message::project(&input, kind, object(event.get("payload")))?;
    if let Some(row) = progress_row {
        append_progress(&ProgressAppend {
            db,
            subscribers,
            chat,
            turn,
            row,
            event_type: "agent.turn_event.progress",
            source_event: Some(&actual_event_id),
            now,
        })?;
    }
    Ok(())
}
