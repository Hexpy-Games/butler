//! `StewardParentProgress` and its presentation/projection.
mod presentation;

use butler_ds::tokens::Length;
use butler_ds::ui::blocks::measure;
use butler_ds::ui::blocks::surface_panel::{Elevation, PanelRadius, SurfacePanel};
use butler_ds::ui::blocks::work_activity::WorkActivityDisclosure;
use butler_ds::ui::context::{Ds, Lang};
use butler_ds::ui::layout::{Space, Stack};
use butler_ds::ui::typo::Typo;
use gpui::{
    AnyElement, App, ElementId, IntoElement as _, ParentElement as _, SharedString, Window,
};

use self::presentation::{
    Anchored, anchored_progress, current_activity_title, effective_steward_status, latest_status,
    step_progress_status, tail, worker_activity_title,
};
use super::timeline::timeline;
use crate::ui::chat::TranscriptCtx;
use crate::ui::source::wire::MessageRecord;

/// The card is narrow below this content width (`useWorkCardNarrow`).
const NARROW_WIDTH: f32 = 480.;

/// Steward children progress under a message; `None` when there is none.
pub(crate) fn steward_progress(
    msg: &MessageRecord,
    t: &TranscriptCtx,
    window: &mut Window,
    cx: &mut App,
) -> Option<AnyElement> {
    let progress = anchored_progress(msg, t.view)?;
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
    let child = progress.child;
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
    let latest = latest_status(lang, progress.rows, &progress.turn.id, live, settled)
        .unwrap_or(activity_label);
    let (previous, earlier) = tail(lang, progress.rows, &progress.turn.id);
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
    if expanded {
        disclosure = disclosure.child(timeline(progress.rows, t, window, cx));
    }
    let header = Stack::row()
        .gap(Space::Sm)
        .child(Typo::label(child.title.clone()).truncate());
    SurfacePanel::new()
        .elevation(Elevation::None)
        .radius(PanelRadius::Lg)
        .child(Stack::new().gap(Space::Sm).child(header).child(disclosure))
        .child(recorder)
        .into_any_element()
}
