//! Dashboard-consumed projection of TaskStore.summaries(25).

use std::path::Path;

use serde::Serialize;

use crate::work_records::read::ReadAvailability;
use crate::work_records::{WorkRecordReadError, read};
use butler_core::locale::LocaleCollation;
use butler_core::public_text::trim_js_whitespace as trim;

use super::evidence;

/// The newest 25 task summaries and the status counts of every task.
pub(super) struct Tasks {
    pub items: Vec<TaskSummary>,
    pub health_running: usize,
    pub health_recoverable: usize,
    pub health_failed: usize,
}

/// One task as TaskStore.summaries reports it.
#[expect(
    clippy::struct_excessive_bools,
    reason = "mirrors the serialized task summary field for field"
)]
#[derive(Clone, Debug, Serialize)]
pub(super) struct TaskSummary {
    pub task_id: String,
    pub status: &'static str,
    pub task_type: &'static str,
    pub planned_status: Option<&'static str>,
    pub public_report_ready: bool,
    pub work_mode: &'static str,
    pub safe_to_report: bool,
    pub completion_claim_allowed: bool,
    pub guard_reason: Option<&'static str>,
    pub user_summary: String,
    pub next_step: &'static str,
    pub has_result: bool,
    pub has_observed_result: bool,
    pub has_log: bool,
    pub can_resume: bool,
}

/// The `butler task list/show` view of a task summary.
#[expect(
    clippy::struct_excessive_bools,
    reason = "mirrors the serialized CLI summary field for field"
)]
#[derive(Serialize)]
pub(super) struct CliSummary {
    task_id: String,
    task_type: &'static str,
    status: &'static str,
    planned_status: Option<&'static str>,
    work_mode: &'static str,
    safe_to_report: bool,
    completion_claim_allowed: bool,
    can_resume: bool,
    user_summary: String,
    next_step: &'static str,
    guard_reason: Option<&'static str>,
    has_result: bool,
    has_log: bool,
}

pub(super) fn summaries(
    root: &Path,
    collation: &LocaleCollation,
) -> Result<Tasks, WorkRecordReadError> {
    let mut tasks = Tasks {
        items: Vec::with_capacity(25),
        health_running: 0,
        health_recoverable: 0,
        health_failed: 0,
    };
    if !root.exists() {
        return Ok(tasks);
    }
    let mut names = Vec::new();
    for entry in std::fs::read_dir(root)? {
        let entry = entry?;
        let name = entry.file_name().to_string_lossy().into_owned();
        let directory = entry.path();
        match read_text(&directory.join("status")).as_str() {
            "RUNNING" => tasks.health_running += 1,
            "RECOVERABLE" => tasks.health_recoverable += 1,
            "FAILED" => tasks.health_failed += 1,
            _ => {}
        }
        if directory.join("status").exists() {
            names.push(name);
        }
    }
    names.sort_by(|a, b| collation.compare(b, a));
    for name in names {
        if tasks.items.len() == 25 {
            break;
        }
        let directory = root.join(&name);
        if !directory.exists() {
            continue;
        }
        tasks.items.push(summary(&name, &directory)?);
    }
    Ok(tasks)
}

/// Summaries whose status (case-insensitively) or work mode is `status`.
pub(super) fn cli_summaries(
    root: &Path,
    status: Option<&str>,
    collation: &LocaleCollation,
) -> Result<Vec<CliSummary>, WorkRecordReadError> {
    let tasks = summaries(root, collation)?;
    Ok(tasks
        .items
        .into_iter()
        .filter(|task| {
            status.is_none_or(|filter| {
                task.status.eq_ignore_ascii_case(filter) || task.work_mode == filter
            })
        })
        .map(|task| cli_summary(&task))
        .collect())
}

pub(super) fn cli_summary_by_id(
    root: &Path,
    id: &str,
) -> Result<Option<CliSummary>, WorkRecordReadError> {
    let directory = root.join(id);
    if !directory.join("status").exists() {
        return Ok(None);
    }
    let task = summary(id, &directory)?;
    Ok(Some(cli_summary(&task)))
}

fn cli_summary(task: &TaskSummary) -> CliSummary {
    let summary_status = task.planned_status.unwrap_or(task.status);
    let task_type = task.task_type;
    let user_summary = match task.work_mode {
        "executing" => format!(
            "{task_type} work is recorded as executing ({summary_status}); current execution is unverified."
        ),
        "repairing" => format!("{task_type} work is recoverable ({summary_status})."),
        "complete" => format!("{task_type} work has completed ({summary_status})."),
        "failed" => format!("{task_type} work needs failure review ({summary_status})."),
        _ => format!("{task_type} work state is {summary_status}."),
    };
    CliSummary {
        task_id: task.task_id.clone(),
        task_type,
        status: task.status,
        planned_status: task.planned_status,
        work_mode: task.work_mode,
        safe_to_report: task.safe_to_report,
        completion_claim_allowed: task.completion_claim_allowed,
        can_resume: task.can_resume,
        user_summary,
        next_step: task.next_step,
        guard_reason: task.guard_reason,
        has_result: task.has_result,
        has_log: task.has_log,
    }
}

fn summary(id: &str, directory: &Path) -> Result<TaskSummary, WorkRecordReadError> {
    let status = normalize_status(&read_text(&directory.join("status")));
    let planned = read::snapshot(directory, ReadAvailability::BestEffort)?;
    let planned_status = planned
        .as_ref()
        .map(|record| normalize_planned(&record.status));
    let public_report = planned
        .as_ref()
        .is_some_and(|_| !read_text(&directory.join("public-report.md")).is_empty());
    let request = read_text(&directory.join("request.md"));
    let result = read_text(&directory.join("result.md"));
    let log = read_text(&directory.join("log.txt"));
    let subject = subject(id, directory, planned.as_ref(), &request);
    let safety = match planned_status {
        Some(planned_status) => evidence::planned(
            planned_status,
            planned
                .as_ref()
                .and_then(|record| record.review.as_ref())
                .and_then(read::ReviewFile::document)
                .and_then(|review| review.verdict.valid())
                .map(String::as_str),
        ),
        None => evidence::direct(directory, status, &request),
    };
    let has_result = !result.is_empty();
    Ok(TaskSummary {
        task_id: id.to_owned(),
        status,
        task_type: if planned_status.is_some() {
            "planned"
        } else {
            "direct"
        },
        planned_status,
        public_report_ready: public_report,
        work_mode: safety.mode,
        safe_to_report: safety.safe,
        completion_claim_allowed: safety.completion,
        guard_reason: safety.guard,
        user_summary: user_summary(&subject, status, planned_status),
        next_step: next_step(status, planned_status),
        has_result,
        has_observed_result: has_result || has_shell_result(&log),
        has_log: !log.is_empty(),
        can_resume: status == "RECOVERABLE",
    })
}

/// What the task is about: its origin summary, plan goal or request, at
/// most 160 UTF-16 units.
fn subject(id: &str, directory: &Path, planned: Option<&read::Snapshot>, request: &str) -> String {
    let origin = std::fs::read(directory.join("origin.json"))
        .ok()
        .and_then(|bytes| serde_json::from_slice::<serde_json::Value>(&bytes).ok())
        .map(|value| crate::lenient::view::<read::Origin>(&value))
        .filter(read::Origin::valid);
    let subject = origin
        .as_ref()
        .and_then(|origin| origin.task_summary.as_deref())
        .filter(|s| !s.is_empty())
        .or_else(|| {
            planned
                .and_then(|record| record.plan.goal.valid())
                .map(String::as_str)
                .filter(|s| !s.is_empty())
        })
        .or_else(|| (!request.is_empty()).then_some(request))
        .map(str::to_owned)
        .unwrap_or_else(|| format!("worker task {id}"));
    compact(&subject, 160)
}

fn normalize_status(value: &str) -> &'static str {
    match value {
        "APPROVED" => "APPROVED",
        "RUNNING" => "RUNNING",
        "DONE" => "DONE",
        "FAILED" => "FAILED",
        "RECOVERABLE" => "RECOVERABLE",
        "REVIEWED" => "REVIEWED",
        "KILLED" => "KILLED",
        _ => "UNKNOWN",
    }
}
fn normalize_planned(value: &str) -> &'static str {
    const PLANNED: [&str; 14] = [
        "PLANNED",
        "PLANNED_RUNNING",
        "WORKER_DONE",
        "WORKER_FAILED",
        "REVIEWING",
        "REVIEW_PASSED",
        "REVIEW_FAILED",
        "REVIEW_INCONCLUSIVE",
        "REPAIRING",
        "PUBLIC_REPORT_READY",
        "FAILED_PUBLIC_REPORT_READY",
        "BLOCKED_WAITING_PRINCIPAL",
        "REPORTED",
        "CANCELLED",
    ];
    PLANNED
        .into_iter()
        .find(|candidate| *candidate == value)
        .unwrap_or("PLANNED")
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
    if normalized.encode_utf16().count() <= limit {
        return normalized.into();
    }
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
