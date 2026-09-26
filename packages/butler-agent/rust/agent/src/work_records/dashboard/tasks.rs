//! Dashboard-consumed projection of TaskStore.summaries(25).

use std::path::Path;

use serde_json::{Value, json};

use crate::{
    locale::LocaleCollation,
    public_text::trim_js_whitespace as trim,
    work_records::{
        WorkRecordReadError,
        read::{self, ReadAvailability},
    },
};

use super::evidence;

pub(super) struct Tasks {
    pub items: Vec<Value>,
    pub health_running: usize,
    pub health_recoverable: usize,
    pub health_failed: usize,
}

pub(super) fn summaries(
    root: &Path,
    collation: &LocaleCollation,
) -> Result<Tasks, WorkRecordReadError> {
    if !root.exists() {
        return Ok(Tasks {
            items: vec![],
            health_running: 0,
            health_recoverable: 0,
            health_failed: 0,
        });
    }
    let mut names = Vec::new();
    let mut running = 0;
    let mut recoverable = 0;
    let mut failed = 0;
    for entry in std::fs::read_dir(root).map_err(|_| WorkRecordReadError)? {
        let entry = entry.map_err(|_| WorkRecordReadError)?;
        let name = entry.file_name().to_string_lossy().into_owned();
        let directory = entry.path();
        match read_text(&directory.join("status")).as_str() {
            "RUNNING" => running += 1,
            "RECOVERABLE" => recoverable += 1,
            "FAILED" => failed += 1,
            _ => {}
        }
        if directory.join("status").exists() {
            names.push(name);
        }
    }
    names.sort_by(|a, b| collation.compare(b, a));
    let mut items = Vec::with_capacity(25);
    for name in names {
        if items.len() == 25 {
            break;
        }
        let directory = root.join(&name);
        if !directory.exists() {
            continue;
        }
        items.push(summary(&name, &directory)?);
    }
    Ok(Tasks {
        items,
        health_running: running,
        health_recoverable: recoverable,
        health_failed: failed,
    })
}

pub(super) fn cli_summaries(
    root: &Path,
    status: Option<&str>,
    collation: &LocaleCollation,
) -> Result<Vec<Value>, WorkRecordReadError> {
    let tasks = summaries(root, collation)?;
    Ok(tasks
        .items
        .iter()
        .filter(|task| {
            status.is_none_or(|filter| {
                text(task, "status").eq_ignore_ascii_case(filter)
                    || text(task, "work_mode") == filter
            })
        })
        .map(cli_summary)
        .collect())
}

pub(super) fn cli_summary_by_id(
    root: &Path,
    id: &str,
) -> Result<Option<Value>, WorkRecordReadError> {
    let directory = root.join(id);
    if !directory.join("status").exists() {
        return Ok(None);
    }
    let task = summary(id, &directory)?;
    Ok(Some(cli_summary(&task)))
}

fn cli_summary(task: &Value) -> Value {
    let status = text(task, "status");
    let planned_status = task.get("planned_status").cloned().unwrap_or(Value::Null);
    let summary_status = planned_status.as_str().unwrap_or(status);
    let task_type = text(task, "task_type");
    let work_mode = text(task, "work_mode");
    let user_summary = match work_mode {
        "executing" => format!(
            "{task_type} work is recorded as executing ({summary_status}); current execution is unverified."
        ),
        "repairing" => format!("{task_type} work is recoverable ({summary_status})."),
        "complete" => format!("{task_type} work has completed ({summary_status})."),
        "failed" => format!("{task_type} work needs failure review ({summary_status})."),
        _ => format!("{task_type} work state is {summary_status}."),
    };
    json!({
        "task_id": task.get("task_id"),
        "task_type": task.get("task_type"),
        "status": task.get("status"),
        "planned_status": planned_status,
        "work_mode": task.get("work_mode"),
        "safe_to_report": task.get("safe_to_report"),
        "completion_claim_allowed": task.get("completion_claim_allowed"),
        "can_resume": task.get("can_resume"),
        "user_summary": user_summary,
        "next_step": task.get("next_step"),
        "guard_reason": task.get("guard_reason"),
        "has_result": task.get("has_result"),
        "has_log": task.get("has_log"),
    })
}

fn summary(id: &str, directory: &Path) -> Result<Value, WorkRecordReadError> {
    let raw_status = read_text(&directory.join("status"));
    let status = normalize_status(&raw_status);
    let planned = read::snapshot(directory, ReadAvailability::BestEffort)?;
    let planned_status = planned
        .as_ref()
        .map(|record| normalize_planned(&record.status));
    let plan = planned.as_ref().map(|record| &record.plan);
    let review = planned.as_ref().and_then(|record| record.review.as_ref());
    let public_report = planned
        .as_ref()
        .is_some_and(|_| !read_text(&directory.join("public-report.md")).is_empty());
    let origin = read_json(&directory.join("origin.json"));
    let origin = origin.as_ref().filter(|origin| {
        origin.get("version").and_then(Value::as_i64) == Some(1)
            && origin
                .get("origin_session_id")
                .and_then(Value::as_str)
                .is_some()
            && origin.get("task_summary").and_then(Value::as_str).is_some()
            && origin
                .pointer("/transcript_ref/path")
                .and_then(Value::as_str)
                .is_some()
    });
    let request = read_text(&directory.join("request.md"));
    let result = read_text(&directory.join("result.md"));
    let log = read_text(&directory.join("log.txt"));
    let subject = origin
        .and_then(|origin| origin.get("task_summary"))
        .and_then(Value::as_str)
        .filter(|s| !s.is_empty())
        .or_else(|| {
            plan.and_then(|plan| plan.get("goal"))
                .and_then(Value::as_str)
                .filter(|s| !s.is_empty())
        })
        .or_else(|| (!request.is_empty()).then_some(request.as_str()))
        .map(str::to_owned)
        .unwrap_or_else(|| format!("worker task {id}"));
    let subject = compact(&subject, 160);
    let user_summary = user_summary(&subject, status, planned_status);
    let next_step = next_step(status, planned_status);
    let safety = match planned_status {
        Some(planned) => evidence::planned(planned, review),
        None => evidence::direct(directory, status, &request),
    };
    let has_result = !result.is_empty();
    let has_observed = has_result || has_shell_result(&log);
    Ok(json!({
        "task_id":id,"status":status,"task_type":if planned_status.is_some() {"planned"} else {"direct"},
        "planned_status":planned_status,"public_report_ready":public_report,
        "work_mode":safety.mode,"safe_to_report":safety.safe,
        "completion_claim_allowed":safety.completion,"guard_reason":safety.guard,
        "user_summary":user_summary,"next_step":next_step,
        "has_result":has_result,"has_observed_result":has_observed,"has_log":!log.is_empty(),
        "can_resume":status=="RECOVERABLE",
    }))
}

fn normalize_status(value: &str) -> &str {
    match value {
        "APPROVED" | "RUNNING" | "DONE" | "FAILED" | "RECOVERABLE" | "REVIEWED" | "KILLED" => value,
        _ => "UNKNOWN",
    }
}
fn normalize_planned(value: &str) -> &str {
    match value {
        "PLANNED"
        | "PLANNED_RUNNING"
        | "WORKER_DONE"
        | "WORKER_FAILED"
        | "REVIEWING"
        | "REVIEW_PASSED"
        | "REVIEW_FAILED"
        | "REVIEW_INCONCLUSIVE"
        | "REPAIRING"
        | "PUBLIC_REPORT_READY"
        | "FAILED_PUBLIC_REPORT_READY"
        | "BLOCKED_WAITING_PRINCIPAL"
        | "REPORTED"
        | "CANCELLED" => value,
        _ => "PLANNED",
    }
}
fn user_summary(subject: &str, status: &str, planned: Option<&str>) -> String {
    if let Some(planned) = planned {
        let suffix = match planned {
            "PUBLIC_REPORT_READY" | "FAILED_PUBLIC_REPORT_READY" => {
                "reviewed report is ready for delivery."
            }
            "REVIEW_PASSED" => "review passed; final report is being prepared.",
            "REVIEW_FAILED" | "REVIEW_INCONCLUSIVE" => {
                "review found gaps; repair or partial reporting is needed."
            }
            "PLANNED_RUNNING" | "REPAIRING" | "REVIEWING" => {
                "planned work was recorded as in progress; current execution is unverified."
            }
            "BLOCKED_WAITING_PRINCIPAL" => "waiting for your decision.",
            _ => return format!("{subject}: planned work status is {planned}."),
        };
        return format!("{subject}: {suffix}");
    }
    let suffix = match status {
        "RUNNING" => "legacy status is RUNNING; current execution is unverified.",
        "RECOVERABLE" => "legacy worker was interrupted; no native execution owner can resume it.",
        "DONE" | "REVIEWED" => "worker completed.",
        "FAILED" => "worker failed; available logs/results can be reviewed.",
        "KILLED" => "worker was stopped.",
        _ => return format!("{subject}: worker status is {status}."),
    };
    format!("{subject}: {suffix}")
}
fn next_step(status: &str, planned: Option<&str>) -> &'static str {
    if status == "RECOVERABLE" {
        return "No native execution owner is available to resume this legacy task.";
    }
    if status == "RUNNING" {
        return "The legacy status says RUNNING; no native execution owner is available to verify or control it.";
    }
    if matches!(
        planned,
        Some("PUBLIC_REPORT_READY" | "FAILED_PUBLIC_REPORT_READY")
    ) {
        return "No native delivery owner is available to deliver this legacy report.";
    }
    if matches!(planned, Some("REVIEW_FAILED" | "REVIEW_INCONCLUSIVE")) {
        return "No native execution owner is available to run a planned repair for this legacy task.";
    }
    if status == "FAILED" {
        return "Summarize the failure from durable result/log evidence.";
    }
    "Answer from durable task state and avoid exposing internal ids unless asked."
}
fn compact(value: &str, limit: usize) -> String {
    let normalized = value.split_whitespace().collect::<Vec<_>>().join(" ");
    let normalized = trim(&normalized);
    if normalized.encode_utf16().count() > limit {
        let mut prefix = String::new();
        let mut units = 0;
        for character in normalized.chars() {
            if units + character.len_utf16() > limit {
                break;
            }
            prefix.push(character);
            units += character.len_utf16();
        }
        format!("{prefix}...")
    } else {
        normalized.into()
    }
}
fn has_shell_result(log: &str) -> bool {
    let mut command = false;
    for line in log.lines() {
        if line.contains("run_shell (") {
            command = true;
        } else if command && line.contains("run_shell result: exit=") {
            return true;
        }
    }
    false
}
fn read_text(path: &Path) -> String {
    std::fs::read(path)
        .map(|bytes| trim(&String::from_utf8_lossy(&bytes)).to_owned())
        .unwrap_or_default()
}
fn read_json(path: &Path) -> Option<Value> {
    serde_json::from_slice(&std::fs::read(path).ok()?).ok()
}

fn text<'a>(value: &'a Value, key: &str) -> &'a str {
    value.get(key).and_then(Value::as_str).unwrap_or("")
}
