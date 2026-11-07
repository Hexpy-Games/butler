//! `ComposerAdjunctPanels` (`WorkProgressPanel`, `WorkerComposerPanel`).
use butler_ds::ui::blocks::todo_progress_panel::{TodoItem, TodoProgressPanel, TodoState};
use butler_ds::ui::blocks::worker_activity::{WorkerActivityPanel, WorkerActivityRow};
use butler_ds::ui::context::Lang;
use butler_ds::ui::layout::{Space, Stack};
use gpui::{AnyElement, IntoElement as _, ParentElement as _};

use crate::ui::source::wire::{
    ProgressRow, WorkerActivitySummary, WorkerActivitySummaryActivityKind,
};
use crate::ui::store::progress::copy::interface_text;
use crate::ui::store::progress::tasks::{ComposerTaskState, project_composer_tasks};

/// The `conversation.work`, `inspector.tabs`, `interfaceFeedback` and `interfaceTemplates`
/// strings these panels read.
struct Words {
    todo_title: &'static str,
    pending: &'static str,
    running: &'static str,
    completed: &'static str,
    reviewing: &'static str,
    correction: &'static str,
    blocked: &'static str,
    skipped: &'static str,
    stopped: &'static str,
    workers: &'static str,
    /// `interfaceFeedback`: thinking, planning, inspecting, executing, verifying, committing,
    /// consolidating, reporting, complete, recoverable.
    phases: [&'static str; 10],
}

const KO: Words = Words {
    todo_title: "진행 단계",
    pending: "대기",
    running: "진행 중",
    completed: "완료",
    reviewing: "검토 중",
    correction: "수정 필요",
    blocked: "막힘",
    skipped: "건너뜀",
    stopped: "중지됨",
    workers: "작업자",
    phases: [
        "생각 중",
        "계획 중",
        "확인 중",
        "실행 중",
        "검증 중",
        "커밋 중",
        "정리 중",
        "보고 중",
        "완료",
        "재개 가능",
    ],
};

const EN: Words = Words {
    todo_title: "Steps",
    pending: "Pending",
    running: "In progress",
    completed: "Done",
    reviewing: "Reviewing",
    correction: "Correction required",
    blocked: "Blocked",
    skipped: "Skipped",
    stopped: "Stopped",
    workers: "Workers",
    phases: [
        "Thinking",
        "Planning",
        "Inspecting",
        "Executing",
        "Verifying",
        "Committing",
        "Consolidating",
        "Reporting",
        "Complete",
        "Recoverable",
    ],
};

const PHASES: [&str; 10] = [
    "orienting",
    "planning",
    "inspecting",
    "executing",
    "verifying",
    "committing",
    "consolidating",
    "reporting",
    "complete",
    "recoverable",
];

fn words(lang: Lang) -> &'static Words {
    match lang {
        Lang::Ko => &KO,
        Lang::En => &EN,
    }
}

/// `composerHasAdjunct`: queued follow-ups live in the conversation, not here.
pub(super) fn has_adjunct(worker_count: usize, task_count: usize) -> bool {
    worker_count > 0 || task_count > 0
}

/// `ComposerAdjunctPanels`. `workers` are the ones the composer shows (`state.workers`),
/// `task_rows` the turn's progress rows (`state.taskRows`).
pub(super) fn adjunct_panels(
    lang: Lang,
    workers: &[WorkerActivitySummary],
    task_rows: &[ProgressRow],
    task_turn_state: Option<&str>,
) -> Option<AnyElement> {
    if !has_adjunct(workers.len(), task_rows.len()) {
        return None;
    }
    let mut stack = Stack::new().gap(Space::Md);
    if !task_rows.is_empty()
        && let Some(panel) = work_progress_panel(lang, task_rows, task_turn_state)
    {
        stack = stack.child(panel);
    }
    if !workers.is_empty() {
        stack = stack.child(worker_composer_panel(lang, workers));
    }
    Some(stack.into_any_element())
}

/// `WorkProgressPanel`.
fn work_progress_panel(
    lang: Lang,
    rows: &[ProgressRow],
    turn_state: Option<&str>,
) -> Option<AnyElement> {
    let tasks = project_composer_tasks(lang, rows, turn_state);
    if tasks.is_empty() {
        return None;
    }
    let words = words(lang);
    let items = tasks
        .into_iter()
        .map(|task| {
            let (state, label) = match task.state {
                ComposerTaskState::Completed => (TodoState::Completed, words.completed),
                ComposerTaskState::Reviewing => (TodoState::Reviewing, words.reviewing),
                ComposerTaskState::CorrectionRequired => {
                    (TodoState::CorrectionRequired, words.correction)
                }
                ComposerTaskState::Blocked => (TodoState::Blocked, words.blocked),
                ComposerTaskState::Skipped => (TodoState::Skipped, words.skipped),
                ComposerTaskState::Stopped => (TodoState::Stopped, words.stopped),
                ComposerTaskState::Running => (TodoState::Running, words.running),
                ComposerTaskState::Pending => (TodoState::Pending, words.pending),
            };
            // `fullTitle` (the tooltip text) has no slot in the DS TodoItem.
            TodoItem::new(task.id, task.label, state, label)
        })
        .collect();
    Some(
        TodoProgressPanel::new("work-progress-panel", words.todo_title)
            .items(items)
            .into_any_element(),
    )
}

/// `WorkerComposerPanel`: the first four groups, parents then their children.
fn worker_composer_panel(lang: Lang, workers: &[WorkerActivitySummary]) -> AnyElement {
    let words = words(lang);
    let groups = group_workers(workers);
    let mut shown: Vec<&WorkerActivitySummary> = Vec::new();
    let mut panel = WorkerActivityPanel::new("worker-composer-panel").heading(words.workers);
    for (parent, children) in groups.into_iter().take(4) {
        if let Some(parent) = parent {
            panel = panel.item(activity_row(lang, parent, 0));
            shown.push(parent);
        }
        for worker in children {
            panel = panel.item(activity_row(lang, worker, usize::from(parent.is_some())));
            shown.push(worker);
        }
    }
    if let Some(first) = shown.first() {
        let summary = collapsed_summary_line(lang, first);
        let remaining = shown.len() - 1;
        panel = panel.collapsed_summary(if remaining > 0 {
            more(lang, &summary, remaining)
        } else {
            summary
        });
    }
    panel.into_any_element()
}

/// `interfaceTemplates.more`.
fn more(lang: Lang, title: &str, count: usize) -> String {
    match lang {
        Lang::Ko => format!("{title} 외 {count}개"),
        Lang::En => format!("{title} and {count} more"),
    }
}

/// `activityRow`.
fn activity_row(lang: Lang, worker: &WorkerActivitySummary, depth: usize) -> WorkerActivityRow {
    let phase = worker.semantic_phase.as_deref().unwrap_or(&worker.phase);
    WorkerActivityRow::new(worker.worker_id.clone(), display_name(worker))
        .description(description(lang, worker))
        .meta(meta(lang, worker))
        .phase(phase.to_owned())
        .depth(depth)
}

/// `worker.task_id ?? worker.orchestration_id`.
fn group_key(worker: &WorkerActivitySummary) -> Option<&str> {
    worker
        .task_id
        .as_deref()
        .or(worker.orchestration_id.as_deref())
}

/// `groupWorkerActivities`: a planned worker with the workers of its orchestration, and the
/// workers that belong to no planned one.
fn group_workers(
    workers: &[WorkerActivitySummary],
) -> Vec<(Option<&WorkerActivitySummary>, Vec<&WorkerActivitySummary>)> {
    let parent_keys: Vec<&str> = workers
        .iter()
        .filter(|worker| is_planned(worker))
        .filter_map(group_key)
        .collect();
    let mut groups = Vec::new();
    for worker in workers {
        if is_planned(worker) {
            let own = group_key(worker).unwrap_or(worker.worker_id.as_str());
            let children = workers
                .iter()
                .filter(|child| !is_planned(child))
                .filter(|child| child.orchestration_id.as_deref() == Some(own))
                .collect();
            groups.push((Some(worker), children));
            continue;
        }
        if worker
            .orchestration_id
            .as_deref()
            .is_some_and(|id| parent_keys.contains(&id))
        {
            continue;
        }
        groups.push((None, vec![worker]));
    }
    groups
}

/// `workerActivityDisplayName`.
fn display_name(worker: &WorkerActivitySummary) -> String {
    let ordinal = worker.worker_ordinal_label.as_deref().map_or("", str::trim);
    let label = worker.worker_label.trim();
    let shown = worker.worker_display_name.as_deref().map_or("", str::trim);
    let from_label = if label.eq_ignore_ascii_case("worker") {
        ordinal
    } else {
        label
    };
    [shown, from_label, ordinal]
        .into_iter()
        .find(|name| !name.is_empty())
        .unwrap_or("Worker")
        .to_owned()
}

/// `isPlannedWorkerActivity`.
fn is_planned(worker: &WorkerActivitySummary) -> bool {
    let name = display_name(worker).to_lowercase();
    let planned_name = name.strip_prefix("planned").is_some_and(|rest| {
        rest.chars()
            .next()
            .is_none_or(|next| !(next.is_ascii_alphanumeric() || next == '_'))
    });
    worker.activity_kind == Some(WorkerActivitySummaryActivityKind::Planned)
        || worker
            .task_id
            .as_deref()
            .is_some_and(|id| id.starts_with("planned-"))
        || planned_name
}

/// `phaseLabel`.
fn phase_label(lang: Lang, phase: &str) -> String {
    if let Some(at) = PHASES.iter().position(|known| *known == phase) {
        return words(lang).phases[at].to_owned();
    }
    let mut chars = phase.chars();
    chars.next().map_or_else(
        || "Worker".to_owned(),
        |first| first.to_uppercase().chain(chars).collect(),
    )
}

/// `workerActivityDescription`.
fn description(lang: Lang, worker: &WorkerActivitySummary) -> String {
    if is_planned(worker) {
        worker.objective.clone()
    } else {
        collapsed_action(lang, worker)
    }
}

/// `workerActivityMeta`.
fn meta(lang: Lang, worker: &WorkerActivitySummary) -> String {
    let phase = phase_label(lang, worker.semantic_phase.as_deref().unwrap_or(&worker.phase));
    match worker.action_kind.as_deref().map(str::trim) {
        Some(action) if !action.is_empty() => format!("{phase} · {action}"),
        _ => phase,
    }
}

/// `workerActivityCollapsedSummaryLine`.
fn collapsed_summary_line(lang: Lang, worker: &WorkerActivitySummary) -> String {
    let phase = phase_label(lang, worker.semantic_phase.as_deref().unwrap_or(&worker.phase));
    let meta = match worker.action_kind.as_deref().map(str::trim) {
        Some(action) if !action.is_empty() => format!("{phase}/{action}"),
        _ => phase,
    };
    format!(
        "{} {meta}: {}",
        display_name(worker),
        collapsed_action(lang, worker)
    )
}

/// `workerActivityCollapsedAction`.
fn collapsed_action(lang: Lang, worker: &WorkerActivitySummary) -> String {
    let current = text(
        lang,
        worker.current_activity_reference.as_ref(),
        worker.current_activity_title.as_deref().unwrap_or(""),
    );
    if !current.is_empty() {
        return current;
    }
    let status = text(lang, worker.status_reference.as_ref(), &worker.status_line);
    if !status.is_empty() {
        return strip_phase_prefix(lang, &status, &worker.phase);
    }
    phase_label(lang, &worker.phase)
}

/// `interfaceText(reference, fallback).trim()`.
fn text(
    lang: Lang,
    reference: Option<&crate::ui::source::wire::InterfaceTextReference>,
    fallback: &str,
) -> String {
    reference
        .map_or_else(|| fallback.to_owned(), |reference| interface_text(lang, reference))
        .trim()
        .to_owned()
}

/// `stripWorkerPhasePrefix`.
fn strip_phase_prefix(lang: Lang, status: &str, phase: &str) -> String {
    let prefix = format!("{}:", phase_label(lang, phase));
    let lower = status.to_lowercase();
    if lower.starts_with(&prefix.to_lowercase())
        && let Some(rest) = status.get(prefix.len()..)
    {
        return rest.trim().to_owned();
    }
    status.to_owned()
}
