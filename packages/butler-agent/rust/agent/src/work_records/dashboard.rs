//! Original TaskStore Work Dashboard, distinct from Project Ledger and BTCC Work.

mod evidence;
mod notifications;
mod tasks;

use std::path::Path;

use serde_json::{Value, json};

use crate::{locale::LocaleCollation, work_records::WorkRecordReadError};

pub(super) fn project(
    tasks_root: &Path,
    debug: bool,
    limit: Option<f64>,
    collation: &LocaleCollation,
) -> Result<Value, WorkRecordReadError> {
    let limit = match limit {
        Some(value) if value.is_nan() => 0,
        Some(value) => crate::json::saturating_usize(value.trunc().clamp(1.0, 25.0)),
        None => 10,
    };
    let tasks = tasks::summaries(tasks_root, collation)?;
    let data = tasks_root.parent().ok_or(WorkRecordReadError::Malformed)?;
    let notifications =
        notifications::pending(&data.join("runtime/task-notifications"), collation)?;
    let active = selected(&tasks.items, limit, debug, |task| {
        text(task, "status") == "RUNNING"
            || matches!(
                text(task, "planned_status"),
                "PLANNED_RUNNING" | "REPAIRING" | "REVIEWING"
            )
    });
    let recoverable = selected(&tasks.items, limit, debug, |task| {
        boolean(task, "can_resume")
    });
    let failed = selected(&tasks.items, limit, debug, |task| {
        text(task, "status") == "FAILED"
            || matches!(
                text(task, "planned_status"),
                "REVIEW_FAILED" | "REVIEW_INCONCLUSIVE"
            )
    });
    let report_ready = selected(&tasks.items, limit, debug, |task| {
        boolean(task, "public_report_ready")
    });
    let delivery = notifications
        .iter()
        .take(limit)
        .enumerate()
        .map(|(index, item)| notifications::item(item, index, debug))
        .collect::<Vec<_>>();
    let pending_count = notifications
        .iter()
        .filter(|item| text(item, "status") == "pending")
        .count();
    let failed_count = notifications
        .iter()
        .filter(|item| text(item, "status") == "failed")
        .count();
    let counts = json!({
        "active":if active.1==0 { tasks.health_running } else { active.1 },
        "recoverable":if recoverable.1==0 { tasks.health_recoverable } else { recoverable.1 },
        "failed":if failed.1==0 { tasks.health_failed } else { failed.1 },
        "reportReady":report_ready.1,
        "pendingDelivery":pending_count,"failedDelivery":failed_count,
    });
    Ok(
        json!({"counts":counts,"active":active.0,"recoverable":recoverable.0,
        "failed":failed.0,"reportReady":report_ready.0,"delivery":delivery,"debug":debug}),
    )
}

pub(super) fn cli_summaries(
    tasks_root: &Path,
    status: Option<&str>,
    collation: &LocaleCollation,
) -> Result<Vec<Value>, WorkRecordReadError> {
    tasks::cli_summaries(tasks_root, status, collation)
}

pub(super) fn cli_summary_by_id(
    tasks_root: &Path,
    id: &str,
) -> Result<Option<Value>, WorkRecordReadError> {
    tasks::cli_summary_by_id(tasks_root, id)
}

fn selected(
    source: &[Value],
    limit: usize,
    debug: bool,
    predicate: impl Fn(&Value) -> bool,
) -> (Vec<Value>, usize) {
    let group: Vec<_> = source.iter().filter(|item| predicate(item)).collect();
    let count = group.len();
    let items = group
        .into_iter()
        .take(limit)
        .enumerate()
        .map(|(index, item)| item_projection(item, index, debug))
        .collect();
    (items, count)
}

fn item_projection(task: &Value, index: usize, debug: bool) -> Value {
    let id = text(task, "task_id");
    let status = text(task, "status");
    let observed = boolean(task, "has_result") || boolean(task, "has_observed_result");
    let mut actions = Vec::with_capacity(3);
    for (action, label, enabled, reason) in [
        (
            "view_result",
            "View result",
            observed || status == "FAILED",
            "No result evidence is available yet.",
        ),
        (
            "resume",
            "Resume",
            false,
            "No native execution owner is available for legacy tasks.",
        ),
        (
            "cancel",
            "Cancel",
            false,
            "No native execution owner is available to cancel legacy tasks.",
        ),
    ] {
        let mut item = json!({"action":action,"label":label,"enabled":enabled});
        if !enabled
            || (action == "view_result"
                && !boolean(task, "has_result")
                && !boolean(task, "has_observed_result"))
        {
            item["reason"] = reason.into();
        }
        if debug {
            item["task_id"] = id.into();
        }
        actions.push(item);
    }
    let mut item = json!({
        "label":if debug { id.to_owned() } else { format!("Work {}",index+1) },
        "status":task.get("planned_status").and_then(Value::as_str).unwrap_or(status),
        "task_type":task.get("task_type"),"work_mode":task.get("work_mode"),
        "safe_to_report":task.get("safe_to_report"),
        "completion_claim_allowed":task.get("completion_claim_allowed"),
        "guard_reason":task.get("guard_reason"),"summary":task.get("user_summary"),
        "next_step":task.get("next_step"),"actions":actions,
    });
    if debug {
        item["raw_id"] = id.into();
    }
    item
}

fn text<'a>(value: &'a Value, key: &str) -> &'a str {
    value.get(key).and_then(Value::as_str).unwrap_or("")
}
fn boolean(value: &Value, key: &str) -> bool {
    value.get(key) == Some(&Value::Bool(true))
}
