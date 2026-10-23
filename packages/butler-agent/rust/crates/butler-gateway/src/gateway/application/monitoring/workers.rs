//! Native worker rows retain their waiting state and localized status reference.
use crate::gateway::AppSessionSummary;
use serde_json::{Value, json};

pub(in crate::gateway::application) fn append_relation_workers(
    workers: &mut Vec<Value>,
    projection: &Value,
    session: &AppSessionSummary,
    collection: &str,
    role: &str,
    include_history: bool,
) {
    let Some(children) = projection.get(collection).and_then(Value::as_array) else {
        return;
    };
    for child in children {
        let status = child
            .get("status")
            .and_then(Value::as_str)
            .unwrap_or("waiting");
        if !include_history && !matches!(status, "active" | "waiting") {
            continue;
        }
        let relation = &child["relation"];
        let task_id = child
            .pointer("/result/task_id")
            .and_then(Value::as_str)
            .filter(|value| !value.is_empty());
        let relation_id = relation
            .get("relation_id")
            .and_then(Value::as_str)
            .filter(|value| !value.is_empty());
        let Some(identity) = relation_id else {
            continue;
        };
        let worker_id = format!("{role}-{identity}");
        let title = child
            .get("title")
            .and_then(Value::as_str)
            .or_else(|| relation.get("safe_title").and_then(Value::as_str))
            .unwrap_or("Native child Work");
        let phase = if child["waiting_for_slot"] == true {
            "waiting"
        } else {
            worker_phase(status)
        };
        let ordinal = relation.get("ordinal").and_then(Value::as_u64).unwrap_or(0);
        let label = if role == "steward" {
            "Steward"
        } else {
            "Worker"
        };
        let ordinal_label = if role == "steward" || ordinal == 0 {
            label.to_owned()
        } else {
            format!("{label} {ordinal}")
        };
        let updated_at = child
            .get("updated_at")
            .and_then(Value::as_str)
            .or_else(|| relation.get("created_at").and_then(Value::as_str))
            .unwrap_or("");
        let mut worker = worker_status_reference(
            phase,
            json!({
                "worker_id": worker_id,
                "activity_kind": "worker",
                "worker_label": label,
                "worker_display_name": label,
                "worker_ordinal_label": ordinal_label,
                "objective": butler_core::public_text::sanitize_public_text(title, "Native child Work"),
                "phase": phase,
                "status_line": worker_status_line(status),
                "session_id": session.id,
                "terminal": matches!(phase, "complete" | "blocked" | "failed" | "cancelled" | "recoverable"),
                "updated_at": updated_at,
                "supported_controls": [],
            }),
        );
        relation_fields(&mut worker, relation, task_id);
        workers.push(worker);
    }
}

fn worker_phase(status: &str) -> &'static str {
    match status {
        "active" => "executing",
        "completed" => "complete",
        "blocked" => "blocked",
        "failed" => "failed",
        "cancelled" => "cancelled",
        "recoverable" => "recoverable",
        _ => "orienting",
    }
}

fn worker_status_line(status: &str) -> &'static str {
    match status {
        "active" => "Working",
        "completed" => "Completed",
        "blocked" => "Blocked",
        "failed" => "Failed",
        "cancelled" => "Cancelled",
        "recoverable" => "Recoverable",
        _ => "Waiting",
    }
}

fn worker_status_reference(phase: &str, mut worker: Value) -> Value {
    if phase == "waiting" {
        butler_core::json::object_mut(&mut worker).insert(
            "status_reference".into(),
            json!({"key":"workerStatus","parameters":{"phase":"waiting"}}),
        );
    }
    worker
}

fn relation_fields(worker: &mut Value, relation: &Value, task_id: Option<&str>) {
    if let Some(parent_turn_id) = relation.get("parent_turn_id").and_then(Value::as_str) {
        worker["parent_turn_id"] = json!(parent_turn_id);
    }
    if let Some(task_id) = task_id {
        worker["task_id"] = json!(task_id);
    }
    if let Some(created_at) = relation.get("created_at").and_then(Value::as_str) {
        worker["created_at"] = json!(created_at);
    }
}
