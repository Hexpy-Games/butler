//! Source-compatible terminal assistant work-block projection.

use serde_json::{Map, Value};

struct Block {
    value: Map<String, Value>,
    rows: Vec<Value>,
    closed: bool,
}

pub(super) fn project(rows: &[Value]) -> Vec<Value> {
    let mut blocks = Vec::<Block>::new();
    let mut current = None::<String>;
    for value in ordered(rows) {
        let Some(row) = value.as_object() else {
            continue;
        };
        if string(row, "kind") == Some("work_block") {
            let Some(id) = truthy_owned(row, "work_block_id") else {
                continue;
            };
            let phase = truthy(row, "work_block_phase");
            if let Some(index) = blocks
                .iter()
                .position(|block| string(&block.value, "id") == Some(&id))
            {
                if blocks[index].closed {
                    continue;
                }
                if phase == Some("updated") {
                    merge_state(&mut blocks[index].value, row);
                } else if phase == Some("completed") {
                    merge_state(&mut blocks[index].value, row);
                    blocks[index].closed = true;
                    if current.as_deref() == Some(&id) {
                        current = None
                    }
                } else if phase.is_none() {
                    merge_state(&mut blocks[index].value, row);
                }
                continue;
            }
            if phase != Some("started") && phase.is_some() {
                continue;
            }
            if let Some(open) = current.take()
                && let Some(block) = blocks
                    .iter_mut()
                    .find(|block| string(&block.value, "id") == Some(&open))
            {
                block.closed = true;
            }
            blocks.push(Block {
                value: block_value(row, &id, false),
                rows: Vec::new(),
                closed: false,
            });
            current = Some(id);
            continue;
        }
        let legacy = string(row, "kind") == Some("message")
            && truthy(row, "work_block_id").is_some()
            && truthy(row, "work_block_label").is_some();
        if legacy {
            let Some(id) = truthy_owned(row, "work_block_id") else {
                continue;
            };
            let index = ensure_block(&mut blocks, row, &id, true);
            add_row(&mut blocks[index], row);
            current = Some(id);
            continue;
        }
        if string(row, "bridge_phase") == Some("btcc_operation") || !tool_activity(row) {
            continue;
        }
        let id = owned(row, "work_block_id").unwrap_or_else(|| {
            format!(
                "unbound:{}",
                owned(row, "tool_call_id")
                    .or_else(|| owned(row, "id"))
                    .unwrap_or_default()
            )
        });
        let existing = blocks
            .iter()
            .position(|block| string(&block.value, "id") == Some(&id));
        if existing.is_none()
            && (truthy(row, "work_decision_id").is_some()
                || row.get("work_block_sequence").is_some())
        {
            continue;
        }
        let index = existing.unwrap_or_else(|| ensure_block(&mut blocks, row, &id, false));
        if blocks[index].closed || current.as_deref().is_some_and(|value| value != id) {
            continue;
        }
        current = Some(id);
        add_row(&mut blocks[index], row);
    }
    blocks
        .into_iter()
        .filter_map(|mut block| {
            let label = string(&block.value, "label")?;
            if crate::public_text::trim_js_whitespace(label).is_empty() {
                return None;
            }
            block.value.insert("rows".into(), Value::Array(block.rows));
            Some(Value::Object(block.value))
        })
        .collect()
}

fn ordered(rows: &[Value]) -> Vec<&Value> {
    let mut values = rows.iter().enumerate().collect::<Vec<_>>();
    values.sort_by(|left, right| {
        order(left.1)
            .partial_cmp(&order(right.1))
            .unwrap_or(std::cmp::Ordering::Equal)
            .then(left.0.cmp(&right.0))
    });
    values.into_iter().map(|(_, row)| row).collect()
}
fn order(value: &Value) -> f64 {
    let Some(row) = value.as_object() else {
        return f64::INFINITY;
    };
    number(row, "turn_event_sequence")
        .or_else(|| number(row, "safe_order"))
        .unwrap_or(f64::INFINITY)
}
fn ensure_block(blocks: &mut Vec<Block>, row: &Map<String, Value>, id: &str, carry: bool) -> usize {
    if let Some(index) = blocks
        .iter()
        .position(|block| string(&block.value, "id") == Some(id))
    {
        return index;
    }
    blocks.push(Block {
        value: block_value(row, id, carry),
        rows: Vec::new(),
        closed: false,
    });
    blocks.len() - 1
}
fn block_value(row: &Map<String, Value>, id: &str, carry: bool) -> Map<String, Value> {
    let label = owned(row, "work_decision_title")
        .or_else(|| owned(row, "work_block_label"))
        .or_else(|| {
            truthy(row, "work_block_id")
                .is_none()
                .then(|| owned(row, "safe_label"))
                .flatten()
        })
        .unwrap_or_default();
    let mut value = Map::new();
    value.insert("id".into(), id.into());
    value.insert("label".into(), label.into());
    value.insert(
        "state".into(),
        row.get("state")
            .cloned()
            .unwrap_or_else(|| "running".into()),
    );
    if let Some(created) = row.get("created_at") {
        value.insert("created_at".into(), created.clone());
    }
    if carry {
        for (from, to) in [
            ("work_decision_title", "decision_title"),
            ("work_decision_summary", "decision_summary"),
            ("work_decision_rationale", "decision_rationale"),
            ("work_decision_next_step", "decision_next_step"),
            ("work_decision_source", "decision_source"),
            ("work_decision_evidence_refs", "decision_evidence_refs"),
        ] {
            if let Some(field) = row.get(from) {
                value.insert(to.into(), field.clone());
            }
        }
    }
    value
}
fn add_row(block: &mut Block, row: &Map<String, Value>) {
    let mut next = row.clone();
    for key in [
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
    ] {
        next.shift_remove(key);
    }
    let key = truthy_owned(row, "tool_call_id")
        .map(|value| format!("tool:{value}"))
        .unwrap_or_else(|| format!("row:{}", owned(row, "id").unwrap_or_default()));
    if let Some(index) = block.rows.iter().position(|value| {
        value.as_object().is_some_and(|value| {
            truthy_owned(value, "tool_call_id")
                .map(|value| format!("tool:{value}"))
                .unwrap_or_else(|| format!("row:{}", owned(value, "id").unwrap_or_default()))
                == key
        })
    }) {
        let current = block.rows[index].as_object().cloned().unwrap_or_default();
        block.rows[index] = Value::Object(merge_tool_row(&current, &next));
    } else {
        block.rows.push(Value::Object(next))
    }
    merge_state(&mut block.value, row);
}
fn merge_state(block: &mut Map<String, Value>, row: &Map<String, Value>) {
    let current = string(block, "state").unwrap_or("");
    let incoming = string(row, "state").unwrap_or("");
    if terminal_state(incoming) || !terminal_state(current) && rank(incoming) >= rank(current) {
        block.insert("state".into(), incoming.into());
    }
}
fn merge_tool_row(
    current: &Map<String, Value>,
    incoming: &Map<String, Value>,
) -> Map<String, Value> {
    let state = merged_state(
        string(current, "state").unwrap_or(""),
        string(incoming, "state").unwrap_or(""),
    );
    let incoming_wins = state == string(incoming, "state").unwrap_or("");
    let (first, second) = if incoming_wins {
        (current, incoming)
    } else {
        (incoming, current)
    };
    let mut merged = first.clone();
    merged.extend(second.clone());
    merged.insert("state".into(), state.into());
    preserve(&mut merged, current, incoming, "created_at");
    preserve_minimum(&mut merged, current, incoming, "turn_event_sequence");
    merged
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
        .reduce(f64::min)
        .and_then(serde_json::Number::from_f64);
    if let Some(value) = value {
        merged.insert(key.into(), Value::Number(value));
    }
}
fn tool_activity(row: &Map<String, Value>) -> bool {
    let kind = string(row, "kind").unwrap_or("");
    if matches!(
        kind,
        "todo" | "message" | "system" | "thinking" | "worked_duration"
    ) {
        return false;
    }
    const INTERNAL_TOOLS: &[&str] = &[
        "Update Todo List",
        "List Todo List",
        "Model preparation",
        "모델 준비",
        "update_todo_list",
        "list_todo_list",
        "model_preparation",
    ];
    if [
        string(row, "safe_tool_name"),
        string(row, "safe_label"),
        string(row, "safe_input_label"),
    ]
    .into_iter()
    .flatten()
    .any(|value| INTERNAL_TOOLS.contains(&value))
    {
        return false;
    }
    if kind == "dispatch" && truthy(row, "tool_call_id").is_none() {
        return false;
    }
    truthy(row, "tool_call_id").is_some()
        || truthy(row, "safe_input_label").is_some()
        || row
            .get("safe_detail_rows")
            .and_then(Value::as_array)
            .is_some_and(|value| !value.is_empty())
        || matches!(
            kind,
            "searched"
                | "read"
                | "ran_command"
                | "edited"
                | "dispatch"
                | "used_tool"
                | "context"
                | "model"
                | "explored"
        )
}
fn terminal_state(value: &str) -> bool {
    matches!(
        value,
        "failed" | "cancelled" | "delivered" | "complete" | "completed" | "stopped"
    )
}
fn merged_state<'a>(current: &'a str, incoming: &'a str) -> &'a str {
    if terminal_state(incoming) {
        incoming
    } else if terminal_state(current) {
        current
    } else if rank(incoming) >= rank(current) {
        incoming
    } else {
        current
    }
}
fn rank(value: &str) -> u8 {
    if matches!(value, "running" | "streaming") {
        2
    } else if matches!(value, "thinking" | "accepted") {
        1
    } else {
        0
    }
}
fn string<'a>(row: &'a Map<String, Value>, key: &str) -> Option<&'a str> {
    row.get(key).and_then(Value::as_str)
}
fn owned(row: &Map<String, Value>, key: &str) -> Option<String> {
    string(row, key).map(str::to_owned)
}
fn truthy<'a>(row: &'a Map<String, Value>, key: &str) -> Option<&'a str> {
    string(row, key).filter(|value| !value.is_empty())
}
fn truthy_owned(row: &Map<String, Value>, key: &str) -> Option<String> {
    truthy(row, key).map(str::to_owned)
}
fn number(row: &Map<String, Value>, key: &str) -> Option<f64> {
    row.get(key)
        .and_then(Value::as_f64)
        .filter(|value| value.is_finite() && *value >= 0.0)
}
