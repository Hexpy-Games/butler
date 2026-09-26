//! Runtime-event sequencing, replay normalization, and terminal authority checks.

mod operation_chunk;

use rusqlite::{Connection, OptionalExtension};
use serde_json::{Map, Value};

use crate::gateway::application::storage::AppStorageError;

pub(super) fn next_sequence(
    db: &Connection,
    field: &str,
    identity: &str,
) -> Result<u64, AppStorageError> {
    super::super::turn_event_sequence::next_sequence(db, field, identity)
}

pub(super) fn sequence(value: Option<&Value>, next: u64) -> u64 {
    value
        .and_then(Value::as_u64)
        .filter(|value| *value > 0 && *value >= next)
        .unwrap_or(next)
}

pub(super) fn prepare_runtime_payload(
    kind: &str,
    visibility: &str,
    payload: Option<&Map<String, Value>>,
) -> Result<Map<String, Value>, AppStorageError> {
    if !valid_kind(kind) {
        return Err(AppStorageError::new(
            "app_turn_event_invalid",
            "Unknown turn event kind",
        ));
    }
    if kind == "operation.output.chunk" {
        return operation_chunk::normalize(payload);
    }
    let mut payload = payload.cloned().unwrap_or_default();
    for key in ["sequence", "charCount", "callIndex", "argumentCharCount"] {
        let Some(value) = payload.get(key).and_then(Value::as_str) else {
            continue;
        };
        if !value.bytes().all(|byte| byte.is_ascii_digit()) {
            continue;
        }
        if let Ok(parsed) = value.parse::<u64>() {
            payload.insert(key.into(), parsed.into());
        }
    }
    validate_provider_stream(kind, visibility, &payload)?;
    if visibility == "internal" {
        return Ok(payload);
    }
    Ok(payload
        .into_iter()
        .filter(|(key, _)| key != "operatorSummary")
        .map(|(key, value)| {
            let sanitized = sanitize_value(&value, &key, kind.starts_with("model.stream."));
            (key, sanitized)
        })
        .collect())
}

fn valid_kind(kind: &str) -> bool {
    matches!(
        kind,
        "turn.started"
            | "turn.first_progress"
            | "turn.iteration.started"
            | "assistant.decision.delta"
            | "assistant.decision.completed"
            | "model.stream.text_delta"
            | "model.stream.reasoning_delta"
            | "model.stream.tool_call_delta"
            | "model.stream.completed"
            | "work.block.started"
            | "work.block.updated"
            | "work.block.completed"
            | "assistant.public_note"
            | "tool_call.finalized"
            | "tool.started"
            | "tool.progress"
            | "tool.completed"
            | "tool.failed"
            | "tool.cancelled"
            | "tool_result.finalized"
            | "tool_result.failed"
            | "operation.output.chunk"
            | "guard.started"
            | "guard.completed"
            | "cognition.feedback.captured"
            | "message.final.started"
            | "message.final.delta"
            | "message.final.completed"
            | "turn.observation"
            | "turn.continuation_scheduled"
            | "turn.completed"
            | "turn.failed"
            | "turn.cancelled"
            | "turn.accepted"
            | "turn.acknowledged"
            | "turn.state_changed"
            | "assistant.decision"
            | "tool.invocation.started"
            | "tool.observation.recorded"
            | "completion.evidence.recorded"
            | "completion.reviewed"
            | "turn.outcome"
            | "runtime.fault"
            | "recovery.recorded"
            | "diagnostic.invariant_violation"
    )
}

fn validate_provider_stream(
    kind: &str,
    visibility: &str,
    payload: &Map<String, Value>,
) -> Result<(), AppStorageError> {
    let invalid =
        || AppStorageError::new("app_turn_event_invalid", "Invalid provider stream payload");
    let required_text = |key: &str| {
        payload
            .get(key)
            .and_then(Value::as_str)
            .map(|value| crate::public_text::sanitize_public_text(value, ""))
            .is_some_and(|value| !value.is_empty())
    };
    let integer = |key: &str| payload.get(key).and_then(Value::as_u64).is_some();
    match kind {
        "model.stream.text_delta"
            if !required_text("streamId")
                || !required_text("textDelta")
                || !matches!(
                    payload.get("target").and_then(Value::as_str),
                    Some("opening_decision" | "public_note" | "final_candidate")
                ) =>
        {
            Err(invalid())
        }
        "model.stream.reasoning_delta"
            if visibility != "internal" || !required_text("streamId") || !integer("charCount") =>
        {
            Err(invalid())
        }
        "model.stream.tool_call_delta"
            if !required_text("streamId")
                || !integer("callIndex")
                || !integer("sequence")
                || !integer("argumentCharCount")
                || (visibility == "public" && payload.contains_key("rawArgumentsDelta"))
                || !matches!(
                    payload.get("publicState").and_then(Value::as_str),
                    Some("generating" | "ready")
                ) =>
        {
            Err(invalid())
        }
        "model.stream.completed"
            if !required_text("streamId")
                || !matches!(
                    payload.get("status").and_then(Value::as_str),
                    Some("completed" | "failed" | "aborted")
                ) =>
        {
            Err(invalid())
        }
        _ => Ok(()),
    }
}

fn sanitize_value(value: &Value, key: &str, preserve_numbers: bool) -> Value {
    let fallback = if decision_key(key) {
        String::new()
    } else {
        fallback(key)
    };
    if key == "retryable" || key == "firstVisible" {
        return value.as_bool().map(Value::Bool).unwrap_or(Value::Null);
    }
    if key == "latencyMs"
        || key == "sourceRevision"
        || preserve_numbers
            && matches!(
                key,
                "sequence" | "charCount" | "callIndex" | "argumentCharCount"
            )
    {
        return non_negative_integer(Some(value))
            .map(Value::from)
            .unwrap_or(Value::Null);
    }
    match value {
        Value::String(text) => {
            Value::String(crate::public_text::sanitize_public_text(text, &fallback))
        }
        Value::Number(_) | Value::Bool(_) => {
            Value::String(crate::public_text::sanitize_public_value(value, &fallback))
        }
        Value::Array(values) => Value::Array(
            values
                .iter()
                .take(12)
                .enumerate()
                .map(|(index, value)| {
                    sanitize_value(value, &format!("{key}_{index}"), preserve_numbers)
                })
                .collect(),
        ),
        Value::Object(values) => Value::Object(
            values
                .iter()
                .map(|(child, value)| {
                    (
                        child.clone(),
                        sanitize_value(value, child, preserve_numbers),
                    )
                })
                .collect(),
        ),
        _ => Value::Null,
    }
}

fn non_negative_integer(value: Option<&Value>) -> Option<u64> {
    match value? {
        Value::Number(number) => number.as_f64(),
        Value::String(text) if !text.trim().is_empty() => text.trim().parse().ok(),
        _ => None,
    }
    .filter(|value| value.is_finite() && *value >= 0.0)
    .map(|value| value.round() as u64)
}

fn decision_key(key: &str) -> bool {
    matches!(
        key,
        "decision"
            | "decisionTitle"
            | "decisionSummary"
            | "decisionRationale"
            | "decisionNextStep"
            | "decisionEvidenceRefs"
            | "decisionSource"
            | "decisionId"
            | "summary"
            | "rationale"
            | "nextStep"
            | "evidenceRefs"
            | "modelCallId"
    )
}

fn fallback(key: &str) -> String {
    let mut output = String::new();
    for part in key.split(['_', '-']).filter(|part| !part.is_empty()) {
        if !output.is_empty() {
            output.push(' ')
        }
        let mut chars = part.chars();
        if let Some(first) = chars.next() {
            output.extend(first.to_uppercase());
            output.extend(chars)
        }
    }
    if output.is_empty() {
        "Value".into()
    } else {
        output
    }
}

pub(super) fn terminal_turn(db: &Connection, turn: &str) -> Result<bool, AppStorageError> {
    let state: String = db
        .query_row("SELECT state FROM turns WHERE id=?1", [turn], |row| {
            row.get(0)
        })
        .map_err(AppStorageError::sqlite)?;
    Ok(matches!(
        state.as_str(),
        "delivered" | "failed" | "cancelled" | "runtime_fault"
    ))
}

pub(super) fn btcc_retains_authority(db: &Connection, turn: &str) -> Result<bool, AppStorageError> {
    let exists = db
        .query_row(
            "SELECT 1 FROM sqlite_master WHERE type='table' AND name='btcc_turns'",
            [],
            |_| Ok(()),
        )
        .optional()
        .map_err(AppStorageError::sqlite)?
        .is_some();
    if !exists {
        return Ok(false);
    }
    let state: Option<String> = db
        .query_row(
            "SELECT semantic_state FROM btcc_turns WHERE turn_id=?1",
            [turn],
            |row| row.get(0),
        )
        .optional()
        .map_err(AppStorageError::sqlite)?;
    Ok(state.is_some_and(|state| !matches!(state.as_str(), "delivered" | "cancelled")))
}
