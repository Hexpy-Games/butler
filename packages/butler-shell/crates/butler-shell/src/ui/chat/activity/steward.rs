//! `StewardParentProgress` and its presentation/projection.
mod anchor;
pub(super) mod presentation;
pub(crate) use anchor::steward_anchors;
mod steps;

use butler_ds::tokens::Length;
use butler_ds::ui::Icon;
use butler_ds::ui::blocks::measure;
use butler_ds::ui::blocks::surface_panel::{Elevation, PanelRadius, SurfacePanel};
use butler_ds::ui::blocks::work_activity::WorkActivityDisclosure;
use butler_ds::ui::button::{self, Size};
use butler_ds::ui::context::{Ds, Lang};
use butler_ds::ui::icon_button::IconButton;
use butler_ds::ui::layout::{Box as DsBox, Cross, Justify, MinWidth, Space, Stack, WithItem as _};
use butler_ds::ui::scroll::{MaxHeight, ScrollArea};
use butler_ds::ui::typo::Typo;
use gpui::{
    AnyElement, App, ElementId, IntoElement as _, ParentElement as _, SharedString, Window,
};
use std::rc::Rc;

use self::anchor::{Anchored, anchored_progress};
use self::presentation::{
    current_activity_title, effective_steward_status, latest_status, step_progress_status, tail,
    worker_activity_title,
};
use super::timeline::timeline;
use crate::ui::chat::TranscriptCtx;
use crate::ui::source::wire::{MessageRecord, ProgressRow, SessionView, StewardSessionSummaryView};

/// The card is narrow below this content width (`useWorkCardNarrow`).
const NARROW_WIDTH: f32 = 480.;

/// Steward children progress under a message; `None` when there is none.
pub(crate) fn steward_progress(
    msg: &MessageRecord,
    t: &TranscriptCtx,
    window: &mut Window,
    cx: &mut App,
) -> Option<AnyElement> {
    let progress = anchored_progress(msg, t)?;
    let lang = Ds::get(cx).lang();
    Some(progress_card(&progress, t, lang, window, cx))
}

/// `StewardParentProgress`: the child's title, its status line and its work timeline.
fn progress_card(
    progress: &Anchored,
    t: &TranscriptCtx,
    lang: Lang,
    window: &mut Window,
    cx: &mut App,
) -> AnyElement {
    let view = super::child_views::view(&progress.child.session_id, cx);
    let child = merged_child(progress.child, view.as_deref());
    let child = &child;
    let turn = child.active_turn.as_ref().or(child.latest_turn.as_ref());
    let rows = turn.map_or(progress.rows, |turn| {
        turn.progress
            .as_ref()
            .map_or(&[][..], |progress| progress.safe_progress_rows.as_slice())
    });
    let turn_id = turn.map_or(progress.turn.id.as_str(), |turn| turn.id.as_str());
    let id = ElementId::from(SharedString::from(format!(
        "steward-progress:{}",
        child.session_id
    )));
    // `useWorkCardNarrow`: the card's content width, as of the last frame.
    let (size, recorder) = measure::track((id.clone(), "card"), window, cx);
    let chrome = 2. * (f32::from(Ds::get(cx).len(Length::SpaceMd)) + 1.);
    let width = f32::from(size.width);
    let narrow = width > 0. && width - chrome < NARROW_WIDTH;
    // `useWorkBlockExpanded`: the details' state lives while the card is on screen.
    let open = window.use_keyed_state((id.clone(), "details"), cx, |_, _| false);
    let expanded = *open.read(cx);

    let live = child.active_turn.is_some() || child.waiting_for_children == Some(true);
    let activity_label =
        worker_activity_title(lang, &current_activity_title(lang, child), &child.title);
    let settled = effective_steward_status(child);
    let latest = latest_status(lang, rows, turn_id, live, settled).unwrap_or(activity_label);
    let (previous, earlier) = tail(lang, view.as_deref(), rows, turn_id);
    let status = step_progress_status(lang, child, narrow);

    let mut disclosure = WorkActivityDisclosure::new((id.clone(), "disclosure"), status, latest)
        .hidden_count(earlier)
        .expanded(expanded)
        .on_toggle(move |_, cx| {
            open.update(cx, |open, cx| {
                *open = !*open;
                cx.notify();
            });
        });
    if let Some(previous) = previous {
        disclosure = disclosure.previous(previous);
    }
    if live {
        disclosure = disclosure.live();
    }
    if expanded
        && let Some(work) = details(
            view.as_ref(),
            (rows, turn_id, &child.session_id),
            live,
            t,
            window,
            cx,
        )
    {
        disclosure = disclosure.child(work);
    }
    let header = header(child, t, window, cx);
    SurfacePanel::new()
        .elevation(Elevation::None)
        .radius(PanelRadius::Lg)
        .child(Stack::new().gap(Space::Sm).child(header).child(disclosure))
        .child(recorder)
        .into_any_element()
}

/// Electron `StewardParentProgress.tsx`: overlay the subscribed child session view.
fn merged_child(
    child: &StewardSessionSummaryView,
    view: Option<&SessionView>,
) -> StewardSessionSummaryView {
    let mut merged = child.clone();
    if let Some(view) = view {
        merged.active_turn.clone_from(&view.active_turn);
        merged.latest_turn.clone_from(&view.latest_turn);
        merged.status.clone_from(&view.status);
        merged.waiting_for_children = view.waiting_for_children;
        merged.plan = view.plan.clone().or(merged.plan);
        merged.approved_plan_total = view.approved_plan_total.or(merged.approved_plan_total);
        merged.approved_plan_completed = view
            .approved_plan_completed
            .or(merged.approved_plan_completed);
    }
    merged
}

/// Electron `StewardProgressHeader`, `appCopy.interfaceDetails.progressDetails` and
/// `appCopy.conversation.work.resumeInterrupted`.
fn header(
    child: &StewardSessionSummaryView,
    t: &TranscriptCtx,
    window: &mut Window,
    cx: &mut App,
) -> AnyElement {
    let ko = Ds::get(cx).lang() == Lang::Ko;
    let mut buttons = button::container(Size::IconSm);
    let turn = child.active_turn.as_ref().or(child.latest_turn.as_ref());
    if turn.is_some_and(|turn| turn.retryable)
        && child.active_turn.is_none()
        && child.result.is_none()
    {
        let relation = child.relation.relation_id.clone();
        let parent = t.view.session_id.clone();
        let resuming = window.use_keyed_state(
            SharedString::from(format!("steward-resuming-{relation}")),
            cx,
            |_, _| false,
        );
        let busy = *resuming.read(cx);
        let mut resume = IconButton::new(
            SharedString::from(format!("steward-resume-{relation}")),
            if ko { "이어서 진행" } else { "Resume" },
        )
        .glyph(Icon::Play)
        .on_click(move |_, window, cx| {
            crate::ui::inspector::sections::subtasks::resume(
                &parent, &relation, &resuming, window, cx,
            );
        });
        if busy {
            resume = resume.disabled();
        }
        buttons = buttons.child(resume);
    }
    let session = child.session_id.clone();
    buttons = buttons.child(
        IconButton::new(
            SharedString::from(format!("steward-observer-{session}")),
            if ko {
                "진행 상세 보기"
            } else {
                "View progress details"
            },
        )
        .glyph(Icon::Eye)
        .on_click(move |_, _, cx| {
            super::tools::worker::open_observer(&session, cx);
        }),
    );
    Stack::row()
        .justify(Justify::Between)
        .cross(Cross::Start)
        .gap(Space::Sm)
        .child(
            Typo::label(child.title.clone())
                .truncate()
                .min_width(MinWidth::Zero)
                .grow(),
        )
        .child(buttons)
        .into_any_element()
}

/// `WorkBlockDetails.tsx`: share the always-subscribed view and follow its live tail.
fn details(
    view: Option<&Rc<SessionView>>,
    (rows, turn_id, session_id): (&[ProgressRow], &str, &str),
    live: bool,
    t: &TranscriptCtx,
    window: &mut Window,
    cx: &mut App,
) -> Option<AnyElement> {
    if let Some((view, plan)) = view.and_then(|view| view.plan.as_ref().map(|plan| (view, plan))) {
        Some(steps::timeline(view, plan, t, window, cx))
    } else {
        let body = timeline(rows, Some(turn_id), None, live, t, window, cx)?;
        Some(
            ScrollArea::new(SharedString::from(format!("plan-details:{session_id}")))
                .max_height(MaxHeight::Sm)
                .follow_end(live)
                .child(DsBox::new().padding_x(Space::Md).child(body))
                .into_any_element(),
        )
    }
}
