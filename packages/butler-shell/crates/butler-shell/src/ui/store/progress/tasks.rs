//! `app/conversation-progress/composer-tasks.ts`: the todo rows of a turn as composer tasks.
use butler_ds::ui::context::Lang;

use super::rows::semantic_progress_rows;
use crate::ui::source::wire::ProgressRow;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum ComposerTaskState {
    Pending,
    Running,
    Reviewing,
    Completed,
    CorrectionRequired,
    Blocked,
    Skipped,
    Stopped,
}

#[derive(Clone, Debug, PartialEq)]
pub(crate) struct ComposerTaskItem {
    pub(crate) id: String,
    pub(crate) label: String,
    pub(crate) full_label: Option<String>,
    pub(crate) state: ComposerTaskState,
}

/// `projectComposerTasks`.
pub(crate) fn project_composer_tasks(
    lang: Lang,
    rows: &[ProgressRow],
    turn_state: Option<&str>,
) -> Vec<ComposerTaskItem> {
    semantic_progress_rows(lang, rows)
        .iter()
        .filter(|row| row.kind.as_deref() == Some("todo"))
        .filter_map(|row| {
            let label = row.safe_label.trim();
            let input = row.safe_input_label.as_deref().map(str::trim).unwrap_or("");
            let id = if input.is_empty() {
                row.id.as_str()
            } else {
                input
            };
            if label.is_empty() || id.is_empty() {
                return None;
            }
            let detail = |kind: &str| {
                row.safe_detail_rows
                    .iter()
                    .flatten()
                    .find(|detail| detail.kind.as_deref() == Some(kind))
                    .and_then(|detail| detail.safe_value.as_deref())
            };
            let full_label = detail("task_description")
                .or_else(|| detail("task_outcome"))
                .map(str::trim)
                .filter(|text| !text.is_empty())
                .map(str::to_string);
            Some(ComposerTaskItem {
                id: id.to_string(),
                label: label.to_string(),
                full_label,
                state: task_state(
                    &row.state,
                    turn_state,
                    row.bridge_phase.as_deref() == Some("btcc_work_ledger"),
                ),
            })
        })
        .collect()
}

fn task_state(
    state: &str,
    turn_state: Option<&str>,
    canonical_work_ledger: bool,
) -> ComposerTaskState {
    let cancelled = turn_state == Some("cancelled");
    if canonical_work_ledger
        && cancelled
        && [
            "active",
            "running",
            "streaming",
            "reviewing",
            "correction_required",
        ]
        .contains(&state)
    {
        return ComposerTaskState::Stopped;
    }
    if !canonical_work_ledger && cancelled && state != "completed" && state != "delivered" {
        return ComposerTaskState::Stopped;
    }
    match state {
        "delivered" | "complete" | "completed" => ComposerTaskState::Completed,
        "reviewing" => ComposerTaskState::Reviewing,
        "failed" | "correction_required" => ComposerTaskState::CorrectionRequired,
        "blocked" => ComposerTaskState::Blocked,
        "skipped" => ComposerTaskState::Skipped,
        "cancelled" | "stopped" => ComposerTaskState::Stopped,
        "running" | "streaming" | "active" => ComposerTaskState::Running,
        _ => ComposerTaskState::Pending,
    }
}
