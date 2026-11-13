//! Electron's `WorkerCallCapsule` reads `worker_label`/`objective`/`phase`, which child
//! summaries do not carry. Like its newer `StepWorkerCapsule`, use title and plan progress.
use butler_ds::ui::button::{Button, Shape, Variant};
use gpui::{AnyElement, App, IntoElement as _, ParentElement as _, SharedString, Styled as _, div};

use super::labels::nonempty;
use crate::ui::chat::{AssistantHooks, TranscriptCtx};
use crate::ui::source::wire::ProgressRow;

/// WorkerCallCapsule: the button that names the worker a `delegate_to_worker` call started.
pub(super) fn capsule(row: &ProgressRow, t: &TranscriptCtx) -> Option<AnyElement> {
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
