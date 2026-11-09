//! `WorkerCallCapsule.tsx` and the helpers it calls (`workerActivityTitle.ts`,
//! `workerActivityLocalization.ts`, `stewardPlanProgress`, `app/utils.ts` worker labels).
use butler_ds::ui::button::{Button, Shape, Variant};
use butler_ds::ui::context::Lang;
use gpui::{AnyElement, App, IntoElement as _, ParentElement as _, SharedString, Styled as _, div};

use super::copy::{find, text, worker_status_key};
use super::labels::{format_interface_text, nonempty};
use crate::ui::chat::{AssistantHooks, TranscriptCtx};
use crate::ui::source::wire::{
    InterfaceTextReference, ProgressRow, WorkerActivitySummary, WorkerActivitySummaryActivityKind,
};

/// WorkerCallCapsule: the button that names the worker a `delegate_to_worker` call started.
pub(super) fn capsule(row: &ProgressRow, t: &TranscriptCtx, lang: Lang) -> Option<AnyElement> {
    if row.safe_tool_name.as_deref() != Some("delegate_to_worker") {
        return None;
    }
    let turn = nonempty(row.turn_id.as_deref())?;
    let call = nonempty(row.tool_call_id.as_deref())?;
    let worker = t.view.workers.iter().find(|worker| {
        worker.parent_turn_id.as_deref() == Some(turn)
            && worker.source_tool_call_id.as_deref() == Some(call)
    })?;
    let progress = plan_progress(worker.approved_plan_total, worker.approved_plan_completed);
    let activity = activity_title(
        &localize(&status_line(worker, lang), lang),
        &worker.objective,
        lang,
    );
    let label = [display_name(worker), progress.unwrap_or_default(), activity]
        .into_iter()
        .filter(|part| !part.is_empty())
        .collect::<Vec<_>>()
        .join(" · ");
    // The click opens the worker's session in the observer (`openSessionObserver`).
    let session = worker
        .session_id
        .clone()
        .unwrap_or_else(|| worker.worker_id.clone());
    let button = Button::new(SharedString::from(format!(
        "worker-call:{}",
        worker.worker_id
    )))
    .variant(Variant::Outline)
    .shape(Shape::Pill)
    .text(label)
    .on_click(move |_, _, cx| open_observer(&session, cx));
    Some(div().flex().child(button).into_any_element())
}

/// `openSessionObserver` through the shell's hook.
fn open_observer(session: &str, cx: &mut App) {
    let open = cx
        .try_global::<AssistantHooks>()
        .and_then(|hooks| hooks.open_observer.clone());
    if let Some(open) = open {
        open(session, cx);
    }
}

/// stewardPlanProgress
fn plan_progress(total: Option<i64>, completed: Option<i64>) -> Option<String> {
    let (total, completed) = (total?, completed?);
    if total < 1 {
        return None;
    }
    let completed = completed.clamp(0, total);
    Some(format!("{}/{total}", (completed + 1).min(total)))
}

/// workerActivityDisplayName
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

/// isPlannedWorkerActivity
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

/// phaseLabel
fn phase_label(phase: &str, lang: Lang) -> String {
    let key = match phase {
        "orienting" => "fb.thinking",
        "planning" => "fb.planning",
        "inspecting" => "fb.inspecting",
        "executing" => "fb.executing",
        "verifying" => "fb.verifying",
        "committing" => "fb.committing",
        "consolidating" => "fb.consolidating",
        "reporting" => "fb.reporting",
        "complete" => "fb.complete",
        "recoverable" => "fb.recoverable",
        _ => {
            let mut chars = phase.chars();
            return chars.next().map_or_else(
                || "Worker".to_owned(),
                |first| first.to_uppercase().chain(chars).collect(),
            );
        }
    };
    text(lang, key).to_owned()
}

/// interfaceText: the reference formatted, else the fallback.
fn interface_text(
    reference: Option<&InterfaceTextReference>,
    fallback: &str,
    lang: Lang,
) -> String {
    reference.map_or_else(
        || fallback.to_owned(),
        |reference| format_interface_text(reference, lang),
    )
}

/// workerActivityStatusLine
fn status_line(worker: &WorkerActivitySummary, lang: Lang) -> String {
    let status = interface_text(worker.status_reference.as_ref(), &worker.status_line, lang);
    let current = interface_text(
        worker.current_activity_reference.as_ref(),
        worker.current_activity_title.as_deref().unwrap_or(""),
        lang,
    );
    let (status, current) = (status.trim(), current.trim());
    let phase = || phase_label(&worker.phase, lang);
    let first_set = |parts: [&str; 2]| {
        parts
            .into_iter()
            .find(|part| !part.is_empty())
            .map(str::to_owned)
    };
    if worker.terminal || worker.phase == "recoverable" || worker.phase == "blocked" {
        return first_set([status, current]).unwrap_or_else(phase);
    }
    if !is_planned(worker) && !current.is_empty() {
        return current.to_owned();
    }
    first_set([current, status]).unwrap_or_else(phase)
}

/// localizeWorkerActivity: legacy gateways send the status text of either locale.
fn localize(value: &str, lang: Lang) -> String {
    worker_status_key(value.trim())
        .and_then(|key| find(lang, &format!("ws.{key}")))
        .unwrap_or(value)
        .to_owned()
}

/// A worker activity title that says something: not a generic label, not a tool identifier.
fn is_useful(value: &str, lang: Lang) -> bool {
    let normalized = value.trim().to_lowercase();
    let generic = [
        text(lang, "st.progress"),
        text(lang, "tool.fallback"),
        text(lang, "d.workerActivity"),
        "작업 중",
        "도구 사용",
        "도구 사용 내역",
        "tool use",
        "tool usage",
        "use tool",
        "working",
        "native child work",
    ];
    let mut segments = normalized.split('_');
    let identifier = segments.next().is_some_and(|first| {
        first.starts_with(|c: char| c.is_ascii_lowercase())
            && first
                .chars()
                .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit())
    }) && {
        let rest: Vec<&str> = segments.collect();
        !rest.is_empty()
            && rest.iter().all(|part| {
                !part.is_empty()
                    && part
                        .chars()
                        .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit())
            })
    };
    !normalized.is_empty()
        && !generic
            .iter()
            .any(|label| normalized == label.trim().to_lowercase())
        && !identifier
}

/// workerActivityTitle
fn activity_title(current: &str, task_title: &str, lang: Lang) -> String {
    let current = current.trim();
    if is_useful(current, lang) {
        return current.to_owned();
    }
    let title = task_title.trim();
    if is_useful(title, lang) {
        return title.to_owned();
    }
    text(lang, "d.workerActivity").to_owned()
}
