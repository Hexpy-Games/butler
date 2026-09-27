use rusqlite::Connection;
use serde_json::Value;

use super::{TypedRegistrationInput, source_changed};
use crate::cognition::{CognitionResult, MEMORY_SOURCE_WINDOW_BYTES, sources};

pub(super) fn validate(input: &TypedRegistrationInput<'_>) -> CognitionResult<()> {
    let owner = input.owner;
    let plan = input.plan;
    let episode_id = sources::projection_hash_for_graph(vec![
        Value::String("typed-memory-record".into()),
        Value::String(owner.source_kind.into()),
        Value::String(owner.record_id.clone()),
    ])?;
    let job_id = sources::projection_hash_for_graph(vec![
        Value::String("memory-projection".into()),
        Value::String(episode_id.clone()),
        Value::String(owner.revision.clone()),
        Value::String("memory-extract-v3".into()),
    ])?;
    if plan.source_key != format!("{}:{}", owner.source_kind, owner.record_id)
        || plan.episode_id != episode_id
        || plan.revision != owner.revision
        || plan.job_id != job_id
        || plan.content_hash != owner.content_hash
        || plan.project_id != owner.project_id
        || plan.session_id != owner.conversation_session_id
        || plan.message_id != owner.conversation_message_id
        || plan.observed_at != owner.observed_at
        || plan.source_kind != owner.source_kind
        || plan.record_id != owner.record_id
    {
        return Err(source_changed());
    }

    let mut expected_windows = Vec::with_capacity(plan.spans.len());
    let mut expected_start = 0;
    for span in &plan.spans {
        let row = &span.row;
        if !row.byte_start.is_finite()
            || !row.byte_end.is_finite()
            || row.byte_start < 0.0
            || row.byte_start.fract() != 0.0
            || row.byte_end.fract() != 0.0
            || row.byte_end <= row.byte_start
            || row.byte_end - row.byte_start > MEMORY_SOURCE_WINDOW_BYTES
        {
            return Err(source_changed());
        }
        let start = crate::json::saturating_usize(row.byte_start);
        let end = crate::json::saturating_usize(row.byte_end);
        if start != expected_start {
            return Err(source_changed());
        }
        expected_start = end;
        let expected_text = owner.text.get(start..end).ok_or_else(source_changed)?;
        let source_id = sources::projection_hash_for_graph(vec![
            Value::String("memory-source".into()),
            Value::String(episode_id.clone()),
            Value::String(owner.revision.clone()),
            Value::String(owner.source_kind.into()),
            Value::String(owner.record_id.clone()),
            Value::Number((start as u64).into()),
            Value::Number((end as u64).into()),
            Value::String(owner.content_hash.clone()),
        ])?;
        if span.text != expected_text
            || row.source_id != source_id
            || row.episode_id != episode_id
            || row.revision != owner.revision
            || row.source_kind != owner.source_kind
            || row.conversation_session_id != owner.conversation_session_id
            || row.conversation_message_id != owner.conversation_message_id
            || row.part_id != owner.record_id
            || row.scalar_pointer != "/text"
            || row.content_hash != owner.content_hash
            || row.role != owner.role
            || row.origin_kind != "unknown"
            || row.observed_at != owner.observed_at
            || row.basis != owner.basis
        {
            return Err(source_changed());
        }
        expected_windows.push(vec![source_id]);
    }
    if expected_start != owner.text.len() || plan.windows != expected_windows {
        return Err(source_changed());
    }
    Ok(())
}

pub(super) fn assert_owner_current(input: &TypedRegistrationInput<'_>) -> CognitionResult<()> {
    let current = sources::read_typed_record(
        input.data_root,
        input.memory_root,
        &input.plan.source_kind,
        &input.plan.record_id,
    )?
    .ok_or_else(source_changed)?;
    if current.operation_id != input.owner.operation_id
        || current.revision != input.owner.revision
        || current.content_hash != input.owner.content_hash
        || current.text != input.owner.text
        || current.source_kind != input.owner.source_kind
        || current.record_id != input.owner.record_id
        || current.record_kind != input.owner.record_kind
        || current.project_id != input.owner.project_id
        || current.conversation_session_id != input.owner.conversation_session_id
        || current.conversation_message_id != input.owner.conversation_message_id
        || current.observed_at != input.owner.observed_at
        || current.role != input.owner.role
        || current.basis != input.owner.basis
    {
        return Err(source_changed());
    }
    Ok(())
}

pub(super) fn persist_rebuild_cursor(
    connection: &Connection,
    input: &TypedRegistrationInput<'_>,
) -> CognitionResult<()> {
    if let (Some(cursor_key), Some(snapshot_id)) = (input.cursor_key, input.cursor_snapshot_id) {
        let value =
            serde_json::json!({"snapshot_id": snapshot_id, "source_key": cursor_key}).to_string();
        connection
            .execute(
                "INSERT INTO memory_state(key,value) VALUES('rebuild_typed_cursor',?1) \
                 ON CONFLICT(key) DO UPDATE SET value=excluded.value",
                [&value],
            )
            .map_err(super::super::db_error)?;
    }
    Ok(())
}
