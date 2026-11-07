//! `SubtaskRows`, `SubtaskWorkerRows`, `SubtaskMark` and `subtasks.ts`: one line per unfinished
//! subtask of the open session, its workers under it, and the mark at the row's end (the plan
//! step while working, resume while paused, the alert while it needs approval).
//!
//! `useRowTitleTooltip` (a cut title shown in full, the action named at rest) is not carried:
//! a truncated title has no measure before paint.
use butler_ds::ui::Icon;
use butler_ds::ui::clickable::{Bleed, Clickable};
use butler_ds::ui::context::Ds;
use butler_ds::ui::icon::{IconSize, icon};
use butler_ds::ui::icon_button::IconButton;
use butler_ds::ui::icon_slot::{IconSlot, SlotSize};
use butler_ds::ui::layout::{Cross, MinWidth, Space, Stack, WithItem as _};
use butler_ds::ui::separator::Separator;
use butler_ds::ui::toast::{self, Toast};
use butler_ds::ui::typo::{Tone, Typo, Wrap};
use gpui::{AnyElement, App, IntoElement as _, ParentElement as _, SharedString, Window};

use crate::ui::chat::AssistantHooks;
use crate::ui::i18n::session_sections::SessionSections;
use crate::ui::source::agent::Jobs;
use crate::ui::source::wire::{
    SubtaskState, SubtaskView, SubtaskWorkerView, SubtaskWorkerViewStatus,
};

/// `SubtaskRows`
pub(super) fn subtask_rows(
    parent_id: &str,
    subtasks: &[SubtaskView],
    window: &mut Window,
    cx: &mut App,
) -> AnyElement {
    let mut rows = Vec::new();
    for subtask in subtasks {
        rows.push(subtask_row(parent_id, subtask, window, cx));
        if let Some(workers) = subtask.workers.as_deref().filter(|w| !w.is_empty()) {
            rows.push(worker_rows(workers, cx));
        }
    }
    Stack::new()
        .gap(Space::None)
        .children(rows)
        .into_any_element()
}

/// `subtaskStateLabel`: the subtask's one muted state word.
fn state_label(state: &SubtaskState, copy: &SessionSections) -> &'static str {
    match state {
        SubtaskState::Paused => copy.subtask_paused,
        SubtaskState::NeedsApproval => copy.subtask_needs_approval,
        _ => copy.working,
    }
}

/// `subtaskProgress`: the plan step in progress as `step/total`.
fn progress(subtask: &SubtaskView) -> Option<String> {
    let (total, completed) = (subtask.plan_total?, subtask.plan_completed?);
    if total < 1 {
        return None;
    }
    Some(format!("{}/{total}", (completed.max(0) + 1).min(total)))
}

/// `openSubtask`: opens the subtask's session. The observer over the parent conversation
/// (`openSessionObserver`) has no route from the inspector.
fn open_subtask(session_id: &str, cx: &mut App) {
    let open = cx
        .try_global::<AssistantHooks>()
        .and_then(|hooks| hooks.open_session.clone());
    if let Some(open) = open {
        open(session_id, cx);
    }
}

/// `SubtaskRow`
fn subtask_row(
    parent_id: &str,
    subtask: &SubtaskView,
    window: &mut Window,
    cx: &mut App,
) -> AnyElement {
    let state = state_label(&subtask.state, SessionSections::get(cx));
    let session = subtask.session_id.clone();
    let mark = subtask_mark(parent_id, subtask, window, cx);
    Clickable::new(SharedString::from(format!(
        "subtask-{}",
        subtask.session_id
    )))
    .bleed(Bleed::Inline)
    .stretch()
    .on_click(move |_, _, cx| open_subtask(&session, cx))
    .child(
        Stack::row()
            .cross(Cross::Center)
            .gap(Space::Sm)
            .grow()
            .min_width(MinWidth::Zero)
            .child(
                Stack::row()
                    .cross(Cross::Baseline)
                    .gap(Space::Xs)
                    .grow()
                    .min_width(MinWidth::Zero)
                    .child(
                        Typo::body(subtask.title.clone())
                            .truncate()
                            .min_width(MinWidth::Zero),
                    )
                    .child(
                        Typo::caption(state)
                            .tone(Tone::Tertiary)
                            .wrap(Wrap::Nowrap)
                            .shrink(false),
                    ),
            )
            .children(mark),
    )
    .into_any_element()
}

/// `SubtaskMark` at the panel's size.
fn subtask_mark(
    parent_id: &str,
    subtask: &SubtaskView,
    window: &mut Window,
    cx: &mut App,
) -> Option<AnyElement> {
    match subtask.state {
        SubtaskState::Paused => Some(resume_button(parent_id, subtask, window, cx)),
        SubtaskState::NeedsApproval => Some(
            IconSlot::new()
                .size(SlotSize::Sm)
                .min_line()
                .child(icon(Icon::CircleAlert, IconSize::Sm, Ds::get(cx)))
                .into_any_element(),
        ),
        // The row's name says the step in words; the digits are decoration.
        _ => progress(subtask).map(|step| {
            Typo::caption(step)
                .tone(Tone::Secondary)
                .tabular()
                .wrap(Wrap::Nowrap)
                .into_any_element()
        }),
    }
}

/// The resume button of a paused subtask; it is disabled while the request runs.
fn resume_button(
    parent_id: &str,
    subtask: &SubtaskView,
    window: &mut Window,
    cx: &mut App,
) -> AnyElement {
    let copy = SessionSections::get(cx);
    let resuming = window.use_keyed_state(
        SharedString::from(format!("subtask-resuming-{}", subtask.relation_id)),
        cx,
        |_, _| false,
    );
    let busy = *resuming.read(cx);
    let (parent, relation) = (parent_id.to_owned(), subtask.relation_id.clone());
    let mut button = IconButton::new(
        SharedString::from(format!("subtask-resume-{}", subtask.relation_id)),
        copy.resume,
    )
    .glyph(Icon::Play)
    .on_click(move |_, window, cx| {
        // The row beneath opens the subtask; the button only resumes it.
        cx.stop_propagation();
        resume(&parent, &relation, &resuming, window, cx);
    });
    if busy {
        button = button.disabled();
    }
    button.into_any_element()
}

/// `resumeObservedSteward`: the agent resumes the relation; a refused request shows the error.
fn resume(
    parent_id: &str,
    relation_id: &str,
    resuming: &gpui::Entity<bool>,
    window: &mut Window,
    cx: &mut App,
) {
    if resuming.update(cx, |busy, _| std::mem::replace(busy, true)) {
        return;
    }
    window.refresh();
    let body = serde_json::json!({ "parent_session_id": parent_id });
    let relation = relation_id.to_owned();
    let done = Jobs::run(cx, move |client| async move {
        client.resume_steward(&relation, &body).await.is_ok()
    });
    let failed = SessionSections::get(cx).resume_failed;
    let resuming = resuming.clone();
    cx.spawn(async move |cx| {
        let accepted = done.await.unwrap_or(false);
        resuming.update(cx, |busy, cx| {
            *busy = false;
            cx.notify();
        });
        if !accepted {
            cx.update(|cx| {
                toast::show(cx, Toast::error(failed));
            });
        }
    })
    .detach();
}

/// `SubtaskWorkerRows`: worker children keep their server order, finished sessions included.
fn worker_rows(workers: &[SubtaskWorkerView], cx: &mut App) -> AnyElement {
    let copy = SessionSections::get(cx);
    Stack::row()
        .gap(Space::None)
        .child(Separator::new().vertical().space(Space::Lg))
        .child(
            Stack::new()
                .gap(Space::None)
                .grow()
                .min_width(MinWidth::Zero)
                .children(workers.iter().map(|worker| worker_row(worker, copy))),
        )
        .into_any_element()
}

/// `WorkerRow`
fn worker_row(worker: &SubtaskWorkerView, copy: &SessionSections) -> AnyElement {
    let (state, failed) = match worker.status {
        SubtaskWorkerViewStatus::Waiting => (copy.worker_waiting, false),
        SubtaskWorkerViewStatus::Completed => (copy.worker_complete, false),
        SubtaskWorkerViewStatus::Failed => (copy.worker_failed, true),
        SubtaskWorkerViewStatus::Blocked => (copy.worker_blocked, false),
        SubtaskWorkerViewStatus::Cancelled => (copy.worker_cancelled, false),
        _ => (copy.worker_executing, false),
    };
    let session = worker.session_id.clone();
    Clickable::new(SharedString::from(format!(
        "subtask-worker-{}",
        worker.session_id
    )))
    .bleed(Bleed::Inline)
    .stretch()
    .on_click(move |_, _, cx| open_subtask(&session, cx))
    .child(
        Stack::row()
            .cross(Cross::Baseline)
            .gap(Space::Xs)
            .grow()
            .min_width(MinWidth::Zero)
            .child(
                Typo::body(worker.title.clone())
                    .truncate()
                    .min_width(MinWidth::Zero),
            )
            .child(
                Typo::caption(state)
                    .tone(if failed { Tone::Danger } else { Tone::Tertiary })
                    .wrap(Wrap::Nowrap)
                    .shrink(false),
            ),
    )
    .into_any_element()
}
