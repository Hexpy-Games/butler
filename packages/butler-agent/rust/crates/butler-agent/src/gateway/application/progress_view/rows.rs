//! Source-compatible semantic merge and terminal filtering for public progress rows.

use std::collections::HashMap;

use serde_json::{Map, Value};

const STATUS_ONLY: &[&str] = &[
    "accepted",
    "started",
    "thinking",
    "working on request",
    "checking response",
    "response checked",
    "preparing final answer",
    "final answer ready",
    "completed",
    "delivered",
];

pub(super) fn public_rows(rows: Vec<Value>, turn_state: &str) -> Vec<Value> {
    let rows = dedupe(rows);
    let semantic_block = rows
        .iter()
        .any(|row| object(row).is_some_and(|row| kind(row) == "work_block" && !first_visible(row)));
    rows.into_iter()
        .filter_map(|mut value| {
            let row = value.as_object_mut()?;
            if turn_state == "delivered" && kind(row) == "turn" && state(row) == "failed" {
                return None;
            }
            if terminal_turn(turn_state) && turn_state != "cancelled" && first_visible(row) {
                return None;
            }
            apply_terminal(row, turn_state);
            session_summary(row, semantic_block).then_some(value)
        })
        .collect()
}

fn dedupe(rows: Vec<Value>) -> Vec<Value> {
    let mut output = Vec::<Map<String, Value>>::new();
    let mut direct = HashMap::<String, usize>::new();
    let mut tool_calls = HashMap::<String, usize>::new();
    for value in rows {
        let Some(row) = value.as_object().cloned() else {
            continue;
        };
        let direct_key = direct_key(&row);
        let tool_call = text(&row, "tool_call_id").map(str::to_owned);
        let index = tool_call
            .as_ref()
            .and_then(|id| tool_calls.get(id).copied())
            .or_else(|| direct.get(&direct_key).copied())
            .or_else(|| semantic_candidate(&output, &row));
        let index = match index {
            Some(index) => {
                output[index] = merge(&output[index], &row);
                index
            }
            None => {
                let index = output.len();
                output.push(row);
                direct.insert(direct_key, index);
                index
            }
        };
        if let Some(id) = text(&output[index], "tool_call_id") {
            tool_calls.insert(id.to_owned(), index);
        }
    }
    output.into_iter().map(Value::Object).collect()
}

fn semantic_candidate(rows: &[Map<String, Value>], incoming: &Map<String, Value>) -> Option<usize> {
    let incoming_tool = text(incoming, "tool_call_id").is_some();
    if !incoming_tool && !legacy_candidate(incoming) {
        return None;
    }
    let matches = rows
        .iter()
        .enumerate()
        .filter(|(_, row)| text(row, "tool_call_id").is_some() != incoming_tool)
        .filter(|(_, row)| semantic_match(row, incoming))
        .map(|(index, _)| index)
        .collect::<Vec<_>>();
    if matches.len() == 1 {
        matches.first().copied()
    } else {
        None
    }
}

fn semantic_match(left: &Map<String, Value>, right: &Map<String, Value>) -> bool {
    if matches!(kind(left), "message" | "system")
        || matches!(kind(right), "message" | "system")
        || kind(left) != kind(right)
        || incompatible(
            text(left, "semantic_block_id"),
            text(right, "semantic_block_id"),
        )
        || incompatible(text(left, "work_block_id"), text(right, "work_block_id"))
        || !details_compatible(left.get("safe_detail_rows"), right.get("safe_detail_rows"))
    {
        return false;
    }
    let left_key = semantic_key(left);
    let right_key = semantic_key(right);
    if left_key.is_some() && left_key == right_key {
        return true;
    }
    compatible_triplet(left, right)
}

fn compatible_triplet(left: &Map<String, Value>, right: &Map<String, Value>) -> bool {
    let labels = (
        normalized(left, "safe_label"),
        normalized(right, "safe_label"),
    );
    let tools = (
        normalized(left, "safe_tool_name"),
        normalized(right, "safe_tool_name"),
    );
    let inputs = (
        normalized(left, "safe_input_label"),
        normalized(right, "safe_input_label"),
    );
    if !labels.0.is_empty() && labels.0 == labels.1 {
        return compatible(&tools.0, &tools.1) && compatible(&inputs.0, &inputs.1);
    }
    !tools.0.is_empty() && tools.0 == tools.1 && !inputs.0.is_empty() && inputs.0 == inputs.1
}

fn merge(current: &Map<String, Value>, incoming: &Map<String, Value>) -> Map<String, Value> {
    if canonical_task(current) && canonical_task(incoming) {
        let mut merged = current.clone();
        merged.extend(incoming.clone());
        preserve_minimum(&mut merged, current, incoming, "safe_order");
        preserve(&mut merged, current, incoming, "created_at");
        return merged;
    }
    let merged_state = merge_state(state(current), state(incoming));
    let incoming_wins = merged_state == state(incoming);
    let (first, second) = if incoming_wins {
        (current, incoming)
    } else {
        (incoming, current)
    };
    let mut merged = first.clone();
    merged.extend(second.clone());
    merged.insert("state".into(), merged_state.into());
    for key in OPTIONAL_FIELDS {
        preserve(&mut merged, second, first, key);
    }
    if kind(current) == "todo" && kind(incoming) == "todo" {
        preserve_minimum(&mut merged, current, incoming, "safe_order");
    }
    preserve_minimum(&mut merged, current, incoming, "turn_event_sequence");
    preserve(&mut merged, current, incoming, "created_at");
    merged
}

const OPTIONAL_FIELDS: &[&str] = &[
    "safe_label",
    "safe_tool_name",
    "safe_input_label",
    "safe_detail_rows",
    "safe_path_labels",
    "tool_call_id",
    "tool_result_id",
    "tool_result_byte_length",
    "bridge_phase",
    "work_contract_id",
    "work_stream_id",
    "semantic_block_id",
    "activity_stage",
    "work_block_id",
    "work_block_label",
    "work_block_phase",
    "work_block_sequence",
    "work_decision_id",
    "work_decision_title",
    "work_decision_summary",
    "work_decision_rationale",
    "work_decision_next_step",
    "work_decision_source",
    "work_decision_evidence_refs",
    "public_decision_model_call_id",
    "public_decision_latency_ms",
];

fn apply_terminal(row: &mut Map<String, Value>, turn_state: &str) {
    if !matches!(
        turn_state,
        "delivered" | "failed" | "cancelled" | "runtime_fault"
    ) {
        return;
    }
    if canonical_task(row) && matches!(state(row), "active" | "reviewing" | "correction_required") {
        row.insert("state".into(), "stopped".into());
        map_detail_states(row, &["active", "reviewing"], "cancelled");
        return;
    }
    let terminal_state = if matches!(turn_state, "failed" | "cancelled") {
        turn_state
    } else {
        "delivered"
    };
    if !terminal(state(row)) {
        row.insert("state".into(), terminal_state.into());
    }
    map_nonterminal_details(row, terminal_state);
}

fn session_summary(row: &Map<String, Value>, semantic_block: bool) -> bool {
    if kind(row) == "thinking" {
        return false;
    }
    if kind(row) == "work_block" {
        return !semantic_block || !first_visible(row);
    }
    if kind(row) == "turn" {
        return text(row, "bridge_phase") == Some("model_round_waiting") && !first_visible(row);
    }
    if matches!(kind(row), "message" | "system") {
        let label = text(row, "work_decision_summary").or_else(|| text(row, "safe_label"));
        return !STATUS_ONLY.contains(&normalized_value(label).as_str());
    }
    true
}

fn first_visible(row: &Map<String, Value>) -> bool {
    matches!(kind(row), "message" | "turn" | "work_block")
        && text(row, "work_block_id").is_some_and(|id| id.starts_with("first-progress-"))
}

fn direct_key(row: &Map<String, Value>) -> String {
    if kind(row) == "work_block"
        && let Some(id) = text(row, "work_block_id")
    {
        return format!("work-event:{}", text(row, "id").unwrap_or(id));
    }
    if let Some(key) = todo_key(row) {
        return format!("todo:{key}");
    }
    if let Some(id) = text(row, "tool_call_id") {
        return format!("tool:{id}");
    }
    if let Some(key) = semantic_key(row) {
        return format!("activity:{key}:row:{}", text(row, "id").unwrap_or(""));
    }
    format!("row:{}", text(row, "id").unwrap_or(""))
}

fn semantic_key(row: &Map<String, Value>) -> Option<String> {
    if matches!(kind(row), "message" | "system") {
        return None;
    }
    todo_key(row).map(|key| format!("todo:{key}")).or_else(|| {
        (!normalized(row, "safe_label").is_empty()).then(|| {
            ["kind", "safe_tool_name", "safe_input_label", "safe_label"]
                .map(|key| normalized(row, key))
                .join(":")
        })
    })
}

fn todo_key(row: &Map<String, Value>) -> Option<String> {
    (kind(row) == "todo")
        .then(|| normalized_value(text(row, "safe_input_label").or_else(|| text(row, "id"))))
        .filter(|value| !value.is_empty())
        .map(|value| format!("id:{value}"))
}

fn preserve(
    merged: &mut Map<String, Value>,
    preferred: &Map<String, Value>,
    fallback: &Map<String, Value>,
    key: &str,
) {
    if let Some(value) = preferred.get(key).or_else(|| fallback.get(key)) {
        merged.insert(key.into(), value.clone());
    }
}

fn preserve_minimum(
    merged: &mut Map<String, Value>,
    left: &Map<String, Value>,
    right: &Map<String, Value>,
    key: &str,
) {
    let value = [left.get(key), right.get(key)]
        .into_iter()
        .flatten()
        .filter_map(Value::as_f64)
        .reduce(f64::min);
    if let Some(value) = value.and_then(serde_json::Number::from_f64) {
        merged.insert(key.into(), Value::Number(value));
    }
}

fn details_compatible(left: Option<&Value>, right: Option<&Value>) -> bool {
    let (Some(left), Some(right)) = (
        left.and_then(Value::as_array),
        right.and_then(Value::as_array),
    ) else {
        return true;
    };
    for item in left.iter().filter_map(Value::as_object) {
        let Some(id) = text(item, "id") else { continue };
        let Some(other) = right
            .iter()
            .filter_map(Value::as_object)
            .find(|row| text(row, "id") == Some(id))
        else {
            continue;
        };
        if incompatible(text(item, "safe_value"), text(other, "safe_value")) {
            return false;
        }
    }
    true
}

fn map_detail_states(row: &mut Map<String, Value>, from: &[&str], to: &str) {
    let Some(details) = row
        .get_mut("safe_detail_rows")
        .and_then(Value::as_array_mut)
    else {
        return;
    };
    for detail in details.iter_mut().filter_map(Value::as_object_mut) {
        if text(detail, "state").is_some_and(|state| from.contains(&state)) {
            detail.insert("state".into(), to.into());
        }
    }
}

fn map_nonterminal_details(row: &mut Map<String, Value>, state: &str) {
    let Some(details) = row
        .get_mut("safe_detail_rows")
        .and_then(Value::as_array_mut)
    else {
        return;
    };
    for detail in details.iter_mut().filter_map(Value::as_object_mut) {
        if text(detail, "state").is_some_and(|value| !terminal(value)) {
            detail.insert("state".into(), state.into());
        }
    }
}

fn normalized(row: &Map<String, Value>, key: &str) -> String {
    normalized_value(text(row, key))
}
fn normalized_value(value: Option<&str>) -> String {
    crate::public_text::trim_js_whitespace(value.unwrap_or("")).to_lowercase()
}
fn kind(row: &Map<String, Value>) -> &str {
    text(row, "kind").unwrap_or("")
}
fn state(row: &Map<String, Value>) -> &str {
    text(row, "state").unwrap_or("")
}
fn object(value: &Value) -> Option<&Map<String, Value>> {
    value.as_object()
}
fn text<'a>(row: &'a Map<String, Value>, key: &str) -> Option<&'a str> {
    row.get(key).and_then(Value::as_str)
}
fn incompatible(left: Option<&str>, right: Option<&str>) -> bool {
    left.is_some() && right.is_some() && left != right
}
fn compatible(left: &str, right: &str) -> bool {
    left.is_empty() || right.is_empty() || left == right
}
fn canonical_task(row: &Map<String, Value>) -> bool {
    kind(row) == "todo" && text(row, "bridge_phase") == Some("btcc_work_ledger")
}
fn legacy_candidate(row: &Map<String, Value>) -> bool {
    !matches!(kind(row), "message" | "system") && !terminal(state(row))
}
fn terminal(state: &str) -> bool {
    matches!(
        state,
        "failed" | "cancelled" | "delivered" | "complete" | "completed" | "stopped"
    )
}
fn terminal_turn(state: &str) -> bool {
    matches!(
        state,
        "delivered" | "failed" | "cancelled" | "runtime_fault"
    )
}
fn merge_state<'a>(current: &'a str, incoming: &'a str) -> &'a str {
    if terminal(incoming) {
        incoming
    } else if terminal(current) {
        current
    } else if rank(incoming) >= rank(current) {
        incoming
    } else {
        current
    }
}
fn rank(state: &str) -> u8 {
    if matches!(state, "running" | "streaming") {
        2
    } else {
        u8::from(matches!(state, "thinking" | "accepted"))
    }
}
