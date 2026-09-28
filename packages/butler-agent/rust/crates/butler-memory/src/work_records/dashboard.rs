//! Original TaskStore Work Dashboard, distinct from Project Ledger and BTCC Work.
//!
//! [`project`] groups the newest task summaries (`tasks`) into active,
//! recoverable, failed and report-ready work, and lists pending delivery
//! notifications (`notifications`); `evidence` decides whether a task may
//! claim completion.

mod evidence;
mod notifications;
mod tasks;

use std::path::Path;

use serde::Serialize;
use serde_json::Value;

use crate::work_records::WorkRecordReadError;
use butler_core::locale::LocaleCollation;
use notifications::DeliveryItem;
use tasks::TaskSummary;

/// How much of each task the dashboard shows.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum DashboardDetail {
    /// Numbered labels without internal ids.
    Public,
    /// Internal task and notification ids as labels.
    Debug,
}

/// The dashboard document.
#[derive(Serialize)]
struct Dashboard<'a> {
    counts: Counts,
    active: Vec<WorkItem<'a>>,
    recoverable: Vec<WorkItem<'a>>,
    failed: Vec<WorkItem<'a>>,
    #[serde(rename = "reportReady")]
    report_ready: Vec<WorkItem<'a>>,
    delivery: Vec<DeliveryItem<'a>>,
    debug: bool,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Counts {
    active: usize,
    recoverable: usize,
    failed: usize,
    report_ready: usize,
    pending_delivery: usize,
    failed_delivery: usize,
}

/// One task row of a dashboard group.
#[derive(Serialize)]
struct WorkItem<'a> {
    label: String,
    status: &'static str,
    task_type: &'static str,
    work_mode: &'static str,
    safe_to_report: bool,
    completion_claim_allowed: bool,
    guard_reason: Option<&'static str>,
    summary: &'a str,
    next_step: &'static str,
    actions: Vec<WorkAction<'a>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    raw_id: Option<&'a str>,
}

/// A (legacy, mostly disabled) action on a task row.
#[derive(Serialize)]
struct WorkAction<'a> {
    action: &'static str,
    label: &'static str,
    enabled: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    reason: Option<&'static str>,
    #[serde(skip_serializing_if = "Option::is_none")]
    task_id: Option<&'a str>,
}

/// A dashboard group: its first `limit` rows and its total size.
struct Group<'a> {
    items: Vec<WorkItem<'a>>,
    count: usize,
}

pub(super) fn project(
    tasks_root: &Path,
    detail: DashboardDetail,
    limit: Option<f64>,
    collation: &LocaleCollation,
) -> Result<Value, WorkRecordReadError> {
    let limit = match limit {
        Some(value) if value.is_nan() => 0,
        Some(value) => butler_core::json::saturating_usize(value.trunc().clamp(1.0, 25.0)),
        None => 10,
    };
    let tasks = tasks::summaries(tasks_root, collation)?;
    let data = tasks_root.parent().ok_or(WorkRecordReadError::Malformed)?;
    let notifications =
        notifications::pending(&data.join("runtime/task-notifications"), collation)?;
    let group =
        |predicate: fn(&TaskSummary) -> bool| selected(&tasks.items, limit, detail, predicate);
    let active = group(|task| {
        task.status == "RUNNING"
            || matches!(
                task.planned_status,
                Some("PLANNED_RUNNING" | "REPAIRING" | "REVIEWING")
            )
    });
    let recoverable = group(|task| task.can_resume);
    let failed = group(|task| {
        task.status == "FAILED"
            || matches!(
                task.planned_status,
                Some("REVIEW_FAILED" | "REVIEW_INCONCLUSIVE")
            )
    });
    let report_ready = group(|task| task.public_report_ready);
    let debug = detail == DashboardDetail::Debug;
    let counted = |status: &str| {
        notifications
            .iter()
            .filter(|item| item.status.as_deref() == Some(status))
            .count()
    };
    let nonzero = |group: usize, health: usize| if group == 0 { health } else { group };
    let dashboard = Dashboard {
        counts: Counts {
            active: nonzero(active.count, tasks.health_running),
            recoverable: nonzero(recoverable.count, tasks.health_recoverable),
            failed: nonzero(failed.count, tasks.health_failed),
            report_ready: report_ready.count,
            pending_delivery: counted("pending"),
            failed_delivery: counted("failed"),
        },
        active: active.items,
        recoverable: recoverable.items,
        failed: failed.items,
        report_ready: report_ready.items,
        delivery: notifications
            .iter()
            .take(limit)
            .enumerate()
            .map(|(index, item)| notifications::item(item, index, debug))
            .collect(),
        debug,
    };
    Ok(serde_json::to_value(dashboard)?)
}

pub(super) fn cli_summaries(
    tasks_root: &Path,
    status: Option<&str>,
    collation: &LocaleCollation,
) -> Result<Vec<Value>, WorkRecordReadError> {
    tasks::cli_summaries(tasks_root, status, collation)?
        .iter()
        .map(|summary| Ok(serde_json::to_value(summary)?))
        .collect()
}

pub(super) fn cli_summary_by_id(
    tasks_root: &Path,
    id: &str,
) -> Result<Option<Value>, WorkRecordReadError> {
    tasks::cli_summary_by_id(tasks_root, id)?
        .map(|summary| Ok(serde_json::to_value(summary)?))
        .transpose()
}

fn selected(
    source: &[TaskSummary],
    limit: usize,
    detail: DashboardDetail,
    predicate: fn(&TaskSummary) -> bool,
) -> Group<'_> {
    let group: Vec<_> = source.iter().filter(|item| predicate(item)).collect();
    Group {
        count: group.len(),
        items: group
            .into_iter()
            .take(limit)
            .enumerate()
            .map(|(index, item)| item_projection(item, index, detail))
            .collect(),
    }
}

fn item_projection(task: &TaskSummary, index: usize, detail: DashboardDetail) -> WorkItem<'_> {
    let debug = detail == DashboardDetail::Debug;
    let id = task.task_id.as_str();
    let observed = task.has_result || task.has_observed_result;
    let actions = [
        (
            "view_result",
            "View result",
            observed || task.status == "FAILED",
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
    ]
    .into_iter()
    .map(|(action, label, enabled, reason)| WorkAction {
        action,
        label,
        enabled,
        reason: (!enabled || (action == "view_result" && !observed)).then_some(reason),
        task_id: debug.then_some(id),
    })
    .collect();
    WorkItem {
        label: if debug {
            id.to_owned()
        } else {
            format!("Work {}", index + 1)
        },
        status: task.planned_status.unwrap_or(task.status),
        task_type: task.task_type,
        work_mode: task.work_mode,
        safe_to_report: task.safe_to_report,
        completion_claim_allowed: task.completion_claim_allowed,
        guard_reason: task.guard_reason,
        summary: &task.user_summary,
        next_step: task.next_step,
        actions,
        raw_id: debug.then_some(id),
    }
}
