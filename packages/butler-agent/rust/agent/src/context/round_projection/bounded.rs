use std::collections::BTreeMap;

use serde_json::{Map, Value};

use super::atomic_units::AtomicUnit;
use super::serialization::{MessageProjection, message_json, messages_json};
use crate::btcc::{BtccError, ModelRoundMessage, ModelRoundRole};

pub(super) struct BoundedProjection {
    pub messages: Option<Vec<ModelRoundMessage>>,
    pub model_facing_bytes: usize,
    pub evicted_atomic_units: usize,
    pub compacted_atomic_units: usize,
}

pub(super) fn project(
    messages: &[ModelRoundMessage],
    units: &[AtomicUnit],
    max_bytes: usize,
) -> Result<BoundedProjection, BtccError> {
    if max_bytes == 0 {
        return Err(BtccError::new(
            "invalid_model_facing_byte_limit",
            "invalid_model_facing_byte_limit",
        ));
    }
    let exact_lengths = messages
        .iter()
        .map(|message| message_json(message, MessageProjection::Exact).map(|json| json.len()))
        .collect::<Result<Vec<_>, _>>()?;
    let mut selected = vec![false; units.len()];
    selected[0] = true;
    for (index, unit) in units.iter().enumerate().skip(1) {
        selected[index] = unit.mandatory;
    }
    let mut replacements = BTreeMap::new();
    let mut current_bytes = selection_bytes(units, &selected, &exact_lengths, &replacements)?;
    if current_bytes <= max_bytes {
        for index in (1..units.len()).rev() {
            if selected[index] {
                continue;
            }
            selected[index] = true;
            let candidate = selection_bytes(units, &selected, &exact_lengths, &replacements)?;
            if candidate <= max_bytes {
                current_bytes = candidate;
                continue;
            }
            if let Some(replacement) = compact(messages, &units[index])? {
                replacements.insert(index, replacement);
                let referenced = selection_bytes(units, &selected, &exact_lengths, &replacements)?;
                if referenced <= max_bytes {
                    current_bytes = referenced;
                    continue;
                }
                replacements.remove(&index);
            }
            selected[index] = false;
        }
    }
    let compacted_atomic_units = replacements.len();
    let evicted_atomic_units = units.len() - selected.iter().filter(|value| **value).count();
    let projected = if evicted_atomic_units > 0 || compacted_atomic_units > 0 {
        let projected = flatten(messages, units, &selected, &replacements);
        let exact = messages_json(projected.iter(), MessageProjection::Exact)?;
        debug_assert_eq!(current_bytes, exact.len());
        Some(projected)
    } else {
        None
    };
    Ok(BoundedProjection {
        model_facing_bytes: current_bytes,
        messages: projected,
        evicted_atomic_units,
        compacted_atomic_units,
    })
}

fn selection_bytes(
    units: &[AtomicUnit],
    selected: &[bool],
    exact_lengths: &[usize],
    replacements: &BTreeMap<usize, Vec<ModelRoundMessage>>,
) -> Result<usize, BtccError> {
    let mut message_count = 0_usize;
    let mut content_bytes = 0_usize;
    for (index, unit) in units.iter().enumerate() {
        if !selected[index] {
            continue;
        }
        if let Some(replacement) = replacements.get(&index) {
            message_count += replacement.len();
            for message in replacement {
                content_bytes += message_json(message, MessageProjection::Exact)?.len();
            }
        } else {
            message_count += unit.range.len();
            content_bytes += exact_lengths[unit.range.clone()].iter().sum::<usize>();
        }
    }
    Ok(2 + content_bytes + message_count.saturating_sub(1))
}

fn flatten(
    messages: &[ModelRoundMessage],
    units: &[AtomicUnit],
    selected: &[bool],
    replacements: &BTreeMap<usize, Vec<ModelRoundMessage>>,
) -> Vec<ModelRoundMessage> {
    let capacity = units
        .iter()
        .enumerate()
        .filter(|(index, _)| selected[*index])
        .map(|(index, unit)| replacements.get(&index).map_or(unit.range.len(), Vec::len))
        .sum();
    let mut flattened = Vec::with_capacity(capacity);
    for (index, unit) in units.iter().enumerate() {
        if selected[index] {
            flattened.extend(
                replacements
                    .get(&index)
                    .map(Vec::as_slice)
                    .unwrap_or(&messages[unit.range.clone()])
                    .iter()
                    .cloned(),
            );
        }
    }
    flattened
}

fn compact(
    messages: &[ModelRoundMessage],
    unit: &AtomicUnit,
) -> Result<Option<Vec<ModelRoundMessage>>, BtccError> {
    let mut changed = false;
    let mut compacted = Vec::with_capacity(unit.range.len());
    for message in &messages[unit.range.clone()] {
        if message.role != ModelRoundRole::Tool {
            compacted.push(message.clone());
            continue;
        }
        let Some(mut payload) = serde_json::from_str::<Value>(&message.content)
            .ok()
            .and_then(|value| value.as_object().cloned())
        else {
            compacted.push(message.clone());
            continue;
        };
        let artifact = payload
            .get("output")
            .and_then(Value::as_object)
            .and_then(|output| output.get("butler_tool_artifact"))
            .cloned();
        let valid_artifact = artifact
            .as_ref()
            .and_then(Value::as_object)
            .is_some_and(|artifact| {
                artifact.get("id").is_some_and(Value::is_string)
                    && artifact.get("path").is_some_and(Value::is_string)
            });
        if message.operation_result_reference.is_none() && !valid_artifact {
            compacted.push(message.clone());
            continue;
        }
        let mut body = Map::new();
        if let Some(ok) = payload.shift_remove("ok") {
            body.insert("ok".into(), ok);
        }
        body.insert("output_omitted".into(), true.into());
        if payload.get("error").is_some_and(js_truthy) {
            body.insert(
                "error".into(),
                payload.shift_remove("error").expect("present error"),
            );
        }
        if let Some(reference) = &message.operation_result_reference {
            body.insert(
                "operation_result".into(),
                serde_json::to_value(reference).map_err(|error| {
                    BtccError::new("context_serialization_failed", error.to_string())
                })?,
            );
        }
        if artifact.as_ref().is_some_and(js_truthy) {
            let mut read = Map::new();
            if let Some(artifact) = artifact.as_ref().and_then(Value::as_object) {
                if let Some(id) = artifact.get("id").and_then(Value::as_str) {
                    read.insert("artifact_id".into(), id.into());
                }
                if let Some(path) = artifact.get("path").and_then(Value::as_str) {
                    read.insert("path".into(), path.into());
                }
            }
            body.insert("read_tool_output_artifact".into(), Value::Object(read));
        }
        let mut next = message.clone();
        next.content = super::serialization::stringify(&Value::Object(body))?.into();
        compacted.push(next);
        changed = true;
    }
    Ok(changed.then_some(compacted))
}

fn js_truthy(value: &Value) -> bool {
    match value {
        Value::Null => false,
        Value::Bool(value) => *value,
        Value::Number(value) => value
            .as_f64()
            .is_some_and(|value| value != 0.0 && !value.is_nan()),
        Value::String(value) => !value.is_empty(),
        Value::Array(_) | Value::Object(_) => true,
    }
}
