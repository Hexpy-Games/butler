//! `taskGraphPresentation.ts`, and the status mapping of `TaskGraphView`.
use std::time::{SystemTime, UNIX_EPOCH};

use butler_ds::ui::blocks::task_graph_card::TaskGraphStatus;
use butler_ds::ui::context::Lang;
use chrono::DateTime;

use crate::ui::i18n::task_graph::{self as copy, Words};
use crate::ui::source::wire::{
    TaskGraphNodeWire, TaskGraphPhaseWire, TaskGraphSnapshotWire, TaskGraphStateWire,
    TaskGraphStatusWire, TaskGraphWorkStateWire,
};

/// `graphTaskStatus`: a skipped action satisfies its dependents, so it reads as done.
pub(super) fn graph_task_status(node: &TaskGraphNodeWire) -> TaskGraphStatus {
    match node.status {
        TaskGraphStatusWire::Running => TaskGraphStatus::Running,
        TaskGraphStatusWire::Review => TaskGraphStatus::Review,
        TaskGraphStatusWire::Done | TaskGraphStatusWire::Skipped => TaskGraphStatus::Done,
        TaskGraphStatusWire::Failed => TaskGraphStatus::Failed,
        TaskGraphStatusWire::Blocked => TaskGraphStatus::Blocked,
        TaskGraphStatusWire::Paused => TaskGraphStatus::Paused,
        TaskGraphStatusWire::Cancelled => TaskGraphStatus::Cancelled,
        TaskGraphStatusWire::Pending | TaskGraphStatusWire::Unknown => TaskGraphStatus::Pending,
    }
}

/// The section status of `TaskGraphView`: blocked work, a waiting graph as pending, else the
/// graph's own state.
pub(super) fn graph_section_status(graph: &TaskGraphSnapshotWire) -> TaskGraphStatus {
    if graph.summary.work_state == TaskGraphWorkStateWire::Blocked {
        return TaskGraphStatus::Blocked;
    }
    match graph.summary.state {
        TaskGraphStateWire::Running => TaskGraphStatus::Running,
        TaskGraphStateWire::Failed => TaskGraphStatus::Failed,
        TaskGraphStateWire::Done => TaskGraphStatus::Done,
        TaskGraphStateWire::Cancelled => TaskGraphStatus::Cancelled,
        TaskGraphStateWire::Waiting | TaskGraphStateWire::Unknown => TaskGraphStatus::Pending,
    }
}

/// `graphCounts`
pub(super) fn graph_counts(lang: Lang, graph: &TaskGraphSnapshotWire) -> String {
    let counts = &graph.summary.counts;
    // A skipped action satisfies its dependents, so it counts toward done.
    let mut parts = vec![copy::done_count(
        lang,
        counts.completed + counts.skipped,
        counts.total,
    )];
    if counts.failed > 0 {
        parts.push(copy::failed_count(lang, counts.failed));
    }
    if counts.cancelled > 0 {
        parts.push(copy::cancelled_count(lang, counts.cancelled));
    }
    parts.join(" · ")
}

/// `graphAssignee`
pub(super) fn graph_assignee(lang: Lang, words: &Words, node: &TaskGraphNodeWire) -> String {
    if node.handled_directly {
        return words.handled_directly.to_owned();
    }
    node.assignee_ordinal.map_or_else(
        || words.unassigned.to_owned(),
        |ordinal| copy::assignee(lang, ordinal),
    )
}

fn parse_ms(at: &str) -> Option<i64> {
    DateTime::parse_from_rfc3339(at)
        .ok()
        .map(|at| at.timestamp_millis())
}

/// The clock `useTaskGraphClock` returns: now, in milliseconds.
pub(super) fn now_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_or(0, |since| i64::try_from(since.as_millis()).unwrap_or(0))
}

/// `graphElapsed`
pub(super) fn graph_elapsed(lang: Lang, node: &TaskGraphNodeWire, now: i64) -> Option<String> {
    let start = parse_ms(node.started_at.as_deref()?)?;
    let end = match node.finished_at.as_deref() {
        Some(finished) => parse_ms(finished)?,
        None if node.status == TaskGraphStatusWire::Running => now,
        None => start,
    };
    Some(copy::elapsed(lang, (end - start) / 1000))
}

/// `graphStatusLabel`
pub(super) fn graph_status_label(words: &Words, node: &TaskGraphNodeWire) -> &'static str {
    match node.status {
        TaskGraphStatusWire::Running => words.running,
        TaskGraphStatusWire::Review => words.review,
        TaskGraphStatusWire::Done => words.done,
        TaskGraphStatusWire::Skipped => words.skipped,
        TaskGraphStatusWire::Failed => words.failed,
        TaskGraphStatusWire::Blocked => words.blocked,
        TaskGraphStatusWire::Paused => words.paused,
        TaskGraphStatusWire::Cancelled => words.cancelled,
        TaskGraphStatusWire::Pending | TaskGraphStatusWire::Unknown => words.pending,
    }
}

/// `graphPhase`
fn graph_phase(words: &Words, graph: &TaskGraphSnapshotWire) -> &'static str {
    match graph.summary.phase {
        TaskGraphPhaseWire::Conception | TaskGraphPhaseWire::Unknown => words.orienting,
        TaskGraphPhaseWire::Planning => words.planning,
        TaskGraphPhaseWire::Execution => words.executing,
        TaskGraphPhaseWire::Review | TaskGraphPhaseWire::Validation => words.verifying,
        TaskGraphPhaseWire::Reporting => words.reporting,
    }
}

/// `graphMeta`: a closed Work keeps its last stage; the section status already says it ended.
pub(super) fn graph_meta(lang: Lang, words: &Words, graph: &TaskGraphSnapshotWire) -> String {
    let counts = graph_counts(lang, graph);
    let closed = matches!(
        graph.summary.work_state,
        TaskGraphWorkStateWire::Completed | TaskGraphWorkStateWire::Abandoned
    );
    if closed {
        counts
    } else {
        format!("{counts} · {}", graph_phase(words, graph))
    }
}
