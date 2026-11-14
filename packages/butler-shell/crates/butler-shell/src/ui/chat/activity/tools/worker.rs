//! Electron's `WorkerCallCapsule` reads `worker_label`/`objective`/`phase`, which child
//! summaries do not carry. Like its newer `StepWorkerCapsule`, use title and plan progress.
use butler_ds::ui::button::{Button, Shape, Variant};
use gpui::{AnyElement, App, IntoElement as _, ParentElement as _, SharedString, Styled as _, div};

use super::labels::nonempty;
use crate::ui::chat::{AssistantHooks, TranscriptCtx};
use crate::ui::source::wire::ProgressRow;

/// WorkerCallCapsule: the button that names the worker a `delegate_to_worker` call started.
pub(super) fn capsule(
    row: &ProgressRow,
    turn: Option<&str>,
    t: &TranscriptCtx,
) -> Option<AnyElement> {
    if row.safe_tool_name.as_deref() != Some("delegate_to_worker") {
        return None;
    }
    let turn = turn.or(nonempty(row.turn_id.as_deref()))?;
    let call = nonempty(row.tool_call_id.as_deref())?;
    let worker = t.view.workers.iter().find(|worker| {
        worker.parent_turn_id.as_deref() == Some(turn)
            && worker.source_tool_call_id.as_deref() == Some(call)
    })?;
    let progress = plan_progress(worker.approved_plan_total, worker.approved_plan_completed);
    let title = nonempty(Some(worker.title.trim())).unwrap_or("Worker");
    let label = [title.to_owned(), progress.unwrap_or_default()]
        .into_iter()
        .filter(|part| !part.is_empty())
        .collect::<Vec<_>>()
        .join(" · ");
    // The click opens the worker's session in the observer (`openSessionObserver`).
    let session = worker.session_id.clone();
    let button = Button::new(SharedString::from(format!(
        "worker-call:{}",
        worker.session_id
    )))
    .variant(Variant::Outline)
    .shape(Shape::Pill)
    .text(label)
    .on_click(move |_, _, cx| {
        open_observer(&session, cx);
    });
    Some(div().flex().child(button).into_any_element())
}

/// `openSessionObserver` through the shell's hook.
pub(crate) fn open_observer(session: &str, cx: &mut App) {
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

/// `StepWorkerCapsule.tsx`: a worker's live state comes from its own session view.
pub(in crate::ui::chat::activity) fn step_capsule(
    worker: &crate::ui::source::wire::StewardSessionSummaryView,
    cx: &mut App,
) -> AnyElement {
    use crate::ui::chat::activity::{child_views, steward::presentation};
    use butler_ds::ui::context::Ds;
    let mut child = worker.clone();
    if let Some(view) = child_views::view(&worker.session_id, cx) {
        child.status.clone_from(&view.status);
        child.active_turn.clone_from(&view.active_turn);
        child.waiting_for_children = view.waiting_for_children;
        child.approved_plan_total = view.approved_plan_total.or(worker.approved_plan_total);
        child.approved_plan_completed = view
            .approved_plan_completed
            .or(worker.approved_plan_completed);
    }
    let lang = Ds::get(cx).lang();
    let live = child.active_turn.is_some() || child.waiting_for_children == Some(true);
    let activity = if live {
        presentation::worker_activity_title(
            lang,
            &presentation::current_activity_title(lang, &child),
            &child.title,
        )
    } else {
        presentation::progress_status(lang, &child)
    };
    let progress = if live {
        presentation::plan_progress(&child)
    } else {
        None
    };
    let label = [child.title, progress.unwrap_or_default(), activity.clone()]
        .into_iter()
        .filter(|part| !part.is_empty())
        .collect::<Vec<_>>()
        .join(" · ");
    let session = worker.session_id.clone();
    let button = Button::new(SharedString::from(format!("step-worker:{session}")))
        .variant(Variant::Outline)
        .shape(Shape::Pill)
        .text(label)
        .on_click(move |_, _, cx| {
            open_observer(&session, cx);
        });
    // `title={activity}`: hovering shows the worker's current activity.
    let pill = if activity.is_empty() {
        button.into_any_element()
    } else {
        butler_ds::ui::tooltip::Tooltip::new(SharedString::from(format!(
            "step-worker-hint:{}",
            worker.session_id
        )))
        .label(activity)
        .child(button)
        .into_any_element()
    };
    crate::ui::widgets::anchor(div().flex().child(pill), "step-worker-capsule").into_any_element()
}
