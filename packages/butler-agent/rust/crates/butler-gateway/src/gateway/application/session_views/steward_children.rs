//! Completes the BTCC Steward child projection to the App `StewardSessionSummaryView`.
//!
//! The BTCC owner projects a child with only ids, states and timestamps. The
//! App contract (`steward_children[]` of `/session-view` and
//! `/session-summary`) also carries per-turn `progress` (with
//! `safe_progress_rows`), `delivery_state`, `cancellable`, `retryable`,
//! limitations, the child's activity rows, artifacts and changed files, and an
//! App `status`. Missing fields are filled with empty values so clients never
//! see a partial turn.

use std::collections::HashMap;

use serde_json::{Map, Value, json};

use super::helpers::child_status;

/// Every distinct turn id of the projected Steward children.
pub(super) fn turn_ids(subsessions: &Value) -> Vec<String> {
    let mut ids = Vec::new();
    for child in children(subsessions) {
        for key in ["active_turn", "latest_turn"] {
            if let Some(id) = child.pointer(&format!("/{key}/id")).and_then(Value::as_str)
                && !ids.iter().any(|seen| seen == id)
            {
                ids.push(id.to_owned());
            }
        }
    }
    ids
}

/// Complete each Steward child in place. `rows` maps a turn id to its public
/// progress rows; a turn without an entry has no rows.
pub(super) fn complete(subsessions: &mut Value, rows: &HashMap<String, Vec<Value>>) {
    let Some(list) = subsessions
        .get_mut("steward_children")
        .and_then(Value::as_array_mut)
    else {
        return;
    };
    for child in list.iter_mut().filter_map(Value::as_object_mut) {
        complete_child(child, rows);
    }
}

/// Complete the `active_turn`/`latest_turn` of a child session's own view.
pub(super) fn complete_view_turns(view: &mut Map<String, Value>) {
    let no_rows = HashMap::new();
    for key in ["active_turn", "latest_turn"] {
        if let Some(turn) = view.get_mut(key).and_then(Value::as_object_mut) {
            complete_turn(turn, &no_rows);
        }
    }
}

fn children(subsessions: &Value) -> impl Iterator<Item = &Value> {
    subsessions
        .get("steward_children")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
}

fn complete_child(child: &mut Map<String, Value>, rows: &HashMap<String, Vec<Value>>) {
    let status = child_status(&Value::Object(child.clone()));
    child.insert("status".into(), json!(status));
    let latest_id = child
        .get("latest_turn")
        .and_then(|turn| turn.get("id"))
        .and_then(Value::as_str)
        .map(str::to_owned);
    let latest_rows = latest_id
        .as_ref()
        .and_then(|id| rows.get(id))
        .cloned()
        .unwrap_or_default();
    if let Some(turn) = child.get_mut("latest_turn").and_then(Value::as_object_mut) {
        complete_turn(turn, rows);
    }
    if child.get("active_turn").is_some_and(Value::is_object) {
        let latest = child.get("latest_turn").cloned().unwrap_or(Value::Null);
        child.insert("active_turn".into(), latest);
    }
    let changed_files = child
        .get("result")
        .and_then(|result| result.get("changed_files"))
        .cloned()
        .unwrap_or_else(|| json!([]));
    child
        .entry("activity_rows")
        .or_insert_with(|| json!(latest_rows));
    child.entry("artifacts").or_insert_with(|| json!([]));
    child.entry("changed_files").or_insert(changed_files);
}

/// A BTCC turn state as an App turn state.
fn app_turn_state(state: &str) -> &str {
    match state {
        "admitted" => "thinking",
        "delivery_committed" => "streaming",
        other => other,
    }
}

fn delivery_state(state: &str) -> &'static str {
    match state {
        "delivered" => "delivered",
        "cancelled" => "cancelled",
        "failed" | "runtime_fault" => "failed_system",
        _ => "running",
    }
}

fn complete_turn(turn: &mut Map<String, Value>, rows: &HashMap<String, Vec<Value>>) {
    let id = turn
        .get("id")
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_owned();
    let state =
        app_turn_state(turn.get("state").and_then(Value::as_str).unwrap_or("idle")).to_owned();
    let terminal = matches!(state.as_str(), "delivered" | "cancelled" | "failed");
    let updated_at = turn.get("updated_at").cloned().unwrap_or(Value::Null);
    turn.insert("state".into(), json!(state));
    turn.entry("delivery_state")
        .or_insert_with(|| json!(delivery_state(&state)));
    turn.entry("limitations").or_insert_with(|| json!([]));
    turn.entry("limitation_codes").or_insert_with(|| json!([]));
    turn.entry("cancellable").or_insert(json!(!terminal));
    turn.entry("retryable").or_insert(json!(false));
    turn.entry("progress").or_insert_with(|| {
        json!({
            "turn_id": id,
            "state": state,
            "delivery_state": delivery_state(&state),
            "updated_at": updated_at,
            "safe_progress_rows": rows.get(&id).cloned().unwrap_or_default(),
        })
    });
}
