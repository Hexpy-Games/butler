//! `StepOrderSection`, `canonOrderModel` and `canon/EpicInspector`.
mod model;
pub(super) mod queue;

use std::rc::Rc;

use butler_ds::tokens::{Color, Length};
use butler_ds::ui::Icon;
use butler_ds::ui::blocks::overflow_action_menu::{OverflowActionMenu, OverflowItem};
use butler_ds::ui::blocks::step_sortable_list::{
    StepSortableChain, StepSortableItem, StepSortableList, StepSortableOutcome,
    StepSortableRowContext, StepSortableRowSlots,
};
use butler_ds::ui::context::Ds;
use butler_ds::ui::icon::icon_px;
use butler_ds::ui::spinner::Spinner;
use butler_ds::ui::success_check::SuccessCheck;
use butler_ds::ui::typo::{Tone, Typo};
use gpui::{
    AnyElement, App, IntoElement as _, ParentElement as _, SharedString, Styled as _, Window, div,
};

use super::InspectorCtx;
use crate::ui::i18n::canon_order::CanonOrder;
use crate::ui::source::wire::{
    CanonQueueChain, CanonQueueItem, CanonQueueItemState, CanonQueueOrigin, CanonQueueView,
};
use model::{
    OrderActionKind, accepts_order_edit, optimistic_order, order_action_to_api, order_chains,
    order_edit_to_api,
};

/// What `StepOrderSection` shows a row's status as.
#[derive(Clone, Copy, PartialEq, Eq)]
enum Status {
    Waiting,
    Running,
    Held,
    Done,
    Failed,
}

/// What the rows read while one frame renders.
struct Rows {
    session_id: String,
    view: CanonQueueView,
    chains: Vec<StepSortableChain>,
    busy: bool,
}

fn origin_copy(copy: &CanonOrder, origin: CanonQueueOrigin) -> &'static str {
    match origin {
        CanonQueueOrigin::Schedule => copy.chain_schedule,
        CanonQueueOrigin::Detach => copy.chain_detach,
        CanonQueueOrigin::UserMessage | CanonQueueOrigin::Unknown => copy.chain_user_message,
    }
}

/// The start now / unstack / remove call of a row menu: reads the view at click time.
fn act(
    session_id: &str,
    kind: OrderActionKind,
    epic_id: &str,
) -> impl Fn(&mut Window, &mut App) + 'static {
    let (session_id, epic_id) = (session_id.to_owned(), epic_id.to_owned());
    move |_, cx| {
        if let Some(view) = queue::snapshot(cx, &session_id).view {
            let input = order_action_to_api(&view, kind, &epic_id);
            queue::edit(cx, &session_id, &input, None);
        }
    }
}

/// The step order section; `None` when the session has no ordered steps.
pub(crate) fn step_order_section(
    ctx: &InspectorCtx<'_>,
    window: &mut Window,
    cx: &mut App,
) -> Option<AnyElement> {
    let session_id = ctx.view.session_id.as_str();
    let snapshot = queue::use_canon_queue(session_id, window, cx);
    let view = snapshot.view?;
    let lang = Ds::get(cx).lang();
    let copy = CanonOrder::get(cx);
    let live: Vec<&CanonQueueChain> = view
        .chains
        .iter()
        .filter(|chain| {
            chain.steps.iter().any(|step| {
                step.items
                    .iter()
                    .any(|item| item.state != CanonQueueItemState::Done)
            })
        })
        .collect();
    let chains: Vec<StepSortableChain> = order_chains(&view)
        .into_iter()
        .filter_map(|mut chain| {
            let origin = live
                .iter()
                .find(|item| item.chain_id == chain.id.as_ref())?
                .origin;
            let label = SharedString::from(origin_copy(copy, origin));
            chain.title = (live.len() > 1).then(|| label.clone());
            chain.label = label;
            Some(chain)
        })
        .collect();
    let rows = Rc::new(Rows {
        session_id: session_id.to_owned(),
        chains: chains.clone(),
        busy: snapshot.busy,
        view,
    });
    let (editing, accepting, rendering) = (rows.clone(), rows.clone(), rows.clone());
    let list = StepSortableList::new("order-steps", chains, move |item, place, window, cx| {
        render_item(&rendering, item, place, window, cx)
    })
    .can_drop(move |edit| accepts_order_edit(&accepting.view, edit))
    .on_edit(move |edit, _, cx| {
        let Some(view) = queue::snapshot(cx, &editing.session_id).view else {
            return;
        };
        if let Some(input) = order_edit_to_api(&view, edit) {
            let next = optimistic_order(&view, edit);
            queue::edit(cx, &editing.session_id, &input, Some(next));
        }
    })
    .labels(CanonOrder::drag(lang))
    .disabled(rows.busy);
    Some(list.into_any_element())
}

/// The status a row shows for its epic.
fn status_of(epic: &CanonQueueItem) -> Status {
    match epic.state {
        CanonQueueItemState::Running if epic.hold_reason.is_some() => Status::Failed,
        CanonQueueItemState::Running => Status::Running,
        CanonQueueItemState::Held => Status::Held,
        CanonQueueItemState::Done => Status::Done,
        CanonQueueItemState::Waiting | CanonQueueItemState::Unknown => Status::Waiting,
    }
}

/// The caption of an epic's own state: its active action, its progress count, or what holds it.
fn progress_state(
    epic: &CanonQueueItem,
    lang: butler_ds::ui::context::Lang,
    copy: &CanonOrder,
) -> Option<String> {
    let progress = &epic.progress;
    progress
        .actions
        .iter()
        .find(|action| action.status == "active")
        .map(|action| action.description.clone())
        .filter(|description| !description.is_empty())
        .or_else(|| {
            (progress.counts.total > 0)
                .then(|| CanonOrder::done(lang, progress.counts.completed, progress.counts.total))
        })
        .or_else(|| {
            epic.held_by_epic_id
                .as_ref()
                .map(|_| copy.held_by.to_owned())
        })
}

/// `renderItem`
fn render_item(
    rows: &Rows,
    item: &StepSortableItem,
    place: &StepSortableRowContext,
    window: &mut Window,
    cx: &mut App,
) -> StepSortableRowSlots {
    let lang = Ds::get(cx).lang();
    let copy = CanonOrder::get(cx);
    let Some(epic) = rows
        .view
        .chains
        .iter()
        .flat_map(|chain| &chain.steps)
        .flat_map(|step| &step.items)
        .find(|epic| epic.epic_id == item.id.as_ref())
    else {
        return StepSortableRowSlots::default();
    };
    let status = status_of(epic);
    let previous = place
        .step_index
        .checked_sub(1)
        .and_then(|at| {
            rows.chains
                .iter()
                .find(|chain| chain.id == place.chain_id)
                .and_then(|chain| chain.steps.get(at))
        })
        .filter(|step| !step.is_empty());
    let after = previous.map(|step| match step.len() {
        1 => CanonOrder::after(lang, &step[0].label),
        count => CanonOrder::after_stack(lang, &step[0].label, count - 1),
    });
    let state = progress_state(epic, lang, copy);
    let caption = match (place.lifted, place.outcome) {
        (true, Some(StepSortableOutcome::Join)) => Some(copy.join.to_owned()),
        (true, Some(StepSortableOutcome::NewStep)) => Some(copy.new_step.to_owned()),
        _ => state.or_else(|| after.map(|(word, name)| format!("{word} {name}"))),
    };
    let meta = match status {
        Status::Waiting | Status::Held => None,
        Status::Failed if epic.hold_reason.as_deref() == Some("step_unfinished") => {
            Some(copy.status_unfinished)
        }
        Status::Failed => Some(copy.status_failed),
        Status::Running => Some(copy.status_running),
        Status::Done => Some(copy.status_done),
    };
    StepSortableRowSlots {
        marker: Some(order_marker(
            status,
            place.step_number,
            &item.id,
            window,
            cx,
        )),
        title: item.label.clone(),
        more: (place.count > 1 && !place.expanded)
            .then(|| CanonOrder::more(lang, place.count - 1).into()),
        meta: meta.map(SharedString::from),
        caption: caption.map(SharedString::from),
        trailing: (!(item.pinned || rows.busy)).then(|| row_menu(rows, epic, place, lang, copy)),
    }
}

/// The row's overflow menu.
fn row_menu(
    rows: &Rows,
    epic: &CanonQueueItem,
    place: &StepSortableRowContext,
    lang: butler_ds::ui::context::Lang,
    copy: &CanonOrder,
) -> AnyElement {
    let id = &epic.epic_id;
    let mut menu = OverflowActionMenu::new(
        SharedString::from(format!("order-menu-{id}")),
        CanonOrder::menu(lang, &epic.title),
    )
    .item(
        OverflowItem::new(copy.start_now)
            .icon(Icon::Play)
            .on_select(act(&rows.session_id, OrderActionKind::StartNow, id)),
    );
    if place.count > 1 {
        menu = menu.item(
            OverflowItem::new(copy.unstack)
                .icon(Icon::Blocks)
                .on_select(act(&rows.session_id, OrderActionKind::Unstack, id)),
        );
    }
    menu.item(
        OverflowItem::new(copy.remove)
            .icon(Icon::Trash2)
            .destructive()
            .on_select(act(&rows.session_id, OrderActionKind::Remove, id)),
    )
    .into_any_element()
}

/// `OrderMarker`: running and done share one slot (the check animates only after the spinner),
/// blocked shows the alert glyph, the rest their step number.
fn order_marker(
    status: Status,
    number: usize,
    id: &SharedString,
    window: &mut Window,
    cx: &mut App,
) -> AnyElement {
    let ds = Ds::get(cx);
    let side = f32::from(ds.len(Length::IconSizeMd));
    match status {
        Status::Running | Status::Done => {
            let loading = status == Status::Running;
            let saw = window.use_keyed_state(format!("order-saw-{id}"), cx, move |_, _| loading);
            if loading && !*saw.read(cx) {
                saw.update(cx, |saw, _| *saw = true);
            }
            if loading {
                Spinner::new(format!("order-spinner-{id}"))
                    .size(side)
                    .into_any_element()
            } else {
                SuccessCheck::new(format!("order-check-{id}"))
                    .ring()
                    .size(side)
                    .animate_if(*saw.read(cx))
                    .into_any_element()
            }
        }
        Status::Failed => div()
            .text_color(ds.color(Color::Danger))
            .child(icon_px(Icon::CircleAlert, ds.len(Length::IconSizeMd)))
            .into_any_element(),
        Status::Waiting | Status::Held => Typo::label(number.to_string())
            .tone(Tone::Tertiary)
            .tabular()
            .into_any_element(),
    }
}

/// `canon/EpicInspector`: deferred to P4, where the canon board owns `EpicDetail` and `useCanonBoard`.
pub(crate) fn epic_inspector(
    ctx: &InspectorCtx<'_>,
    window: &mut Window,
    cx: &mut App,
) -> Option<AnyElement> {
    let _ = (ctx, window, cx);
    None
}
