//! Completes the BTCC Steward child projection to the App `StewardSessionSummaryView`.
//!
//! The BTCC owner projects a child with only ids, states and timestamps. The
//! App contract (`steward_children[]` of `/session-view` and
//! `/session-summary`) also carries per-turn `progress` (with
//! `safe_progress_rows`), `delivery_state`, `cancellable`, `retryable`,
//! limitations, the child's activity rows, artifacts and changed files, and an
//! App `status`. Missing fields are filled with empty values so clients never
//! see a partial turn. Progress rows are not projected yet (always empty).

use serde_json::{Map, Value, json};

use super::helpers::child_status;

/// How long a Steward's delivered turn may wait for its result to be
/// committed. The host commits the result right after it delivers the turn
/// (`complete_subsession_child`); a delivered turn without a result after this
/// window is an orphan (the commit failed, e.g. the child's Work was not
/// terminal) and never becomes a result by itself.
const RESULT_COMMIT_GRACE_MS: i64 = 5 * 60 * 1000;

/// Complete each Steward child in place; `now_ms` is the current time.
pub(super) fn complete(subsessions: &mut Value, now_ms: i64) {
    let Some(list) = subsessions
        .get_mut("steward_children")
        .and_then(Value::as_array_mut)
    else {
        return;
    };
    for child in list.iter_mut().filter_map(Value::as_object_mut) {
        complete_child(child, now_ms);
    }
}

/// Complete the `active_turn`/`latest_turn` of a child session's own view.
pub(super) fn complete_view_turns(view: &mut Map<String, Value>) {
    for key in ["active_turn", "latest_turn"] {
        if let Some(turn) = view.get_mut(key).and_then(Value::as_object_mut) {
            complete_turn(turn);
        }
    }
}

/// Complete one turn value (a child session's `latest_turn`).
pub(super) fn complete_turn_value(turn: &mut Value) {
    if let Some(turn) = turn.as_object_mut() {
        complete_turn(turn);
    }
}

fn complete_child(child: &mut Map<String, Value>, now_ms: i64) {
    let raw = Value::Object(child.clone());
    let mut status = child_status(&raw);
    if is_orphan(&raw, now_ms) {
        status = "failed";
        child.insert("terminal".into(), json!(true));
        child.insert("result_missing".into(), json!(true));
    }
    child.insert("status".into(), json!(status));
    if let Some(turn) = child.get_mut("latest_turn").and_then(Value::as_object_mut) {
        complete_turn(turn);
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
    child.entry("activity_rows").or_insert_with(|| json!([]));
    child.entry("artifacts").or_insert_with(|| json!([]));
    child.entry("changed_files").or_insert(changed_files);
}

/// A child without a result whose latest turn settled longer ago than the
/// commit grace.
fn is_orphan(child: &Value, now_ms: i64) -> bool {
    if child.get("result").is_some_and(|result| !result.is_null()) {
        return false;
    }
    let settled = matches!(
        child.pointer("/latest_turn/state").and_then(Value::as_str),
        Some("delivered" | "cancelled")
    );
    let updated = child
        .pointer("/latest_turn/updated_at")
        .and_then(Value::as_str)
        .and_then(butler_core::js_date::parse_iso_millis);
    settled
        && updated.is_some_and(|updated| now_ms.saturating_sub(updated) > RESULT_COMMIT_GRACE_MS)
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

fn complete_turn(turn: &mut Map<String, Value>) {
    let id = turn.get("id").cloned().unwrap_or(Value::Null);
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
            "safe_progress_rows": [],
        })
    });
}
