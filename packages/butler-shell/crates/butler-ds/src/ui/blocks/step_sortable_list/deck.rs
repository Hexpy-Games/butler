//! A 묶음 (stack) of cards that run together (`StackDeck`, `StackDeckCard`, `StackDeckColumn`),
//! private to this block: the DS crate has no StackDeck block. Collapsed, the front card is a
//! normal full-width row whose card is the toggle; one hairline edge per further card (up to
//! three) shows past its right side. Open, one full-width card per item in a column, each card
//! folding the column. Not reproduced: the slide of the cards between the two states and the
//! entering edge (they swap at once).
use gpui::{
    AnyElement, App, FocusHandle, InteractiveElement as _, IntoElement as _, ParentElement as _,
    SharedString, Styled as _, Window, div, px, relative,
};

use super::grip::{Grip, draggable};
use super::row::{RowArgs, row};
use super::session::{item_drag_id, set_fanned, step_drag_id};
use super::model::{is_draggable, is_pinned_step};
use super::{Env, StepSortableItem, StepSortableRowContext, sub};
use crate::tokens::{Color, Length};
use crate::ui::card::Card;
use crate::ui::context::Ds;

/// Edges a collapsed deck shows on its right; the rest are only in the front card's count.
const MAX_PEEKS: u8 = 3; // DS: StackDeck.tsx:55

pub(super) struct DeckArgs<'a> {
    pub step: &'a [StepSortableItem],
    pub expanded: bool,
    /// False while a drag runs and on the lifted copy: no toggle, no hover.
    pub interactive: bool,
    /// The row context of the cards (the lifted copy sets `lifted` and `outcome`).
    pub base: StepSortableRowContext,
}

/// The edges behind a collapsed deck: the right end of a card behind each, no fill, the card's
/// border token and corner. Each continues from the corner of the shape in front of it.
fn peeks(extra: usize, live: bool, group: &SharedString, ds: &Ds) -> AnyElement {
    let (room, step, radius, hair) = (
        ds.len(Length::FocusRingRoom),
        ds.len(Length::SpaceXs), // DS: StackDeck.module.css:11
        ds.len(Length::RadiusControl),
        ds.len(Length::BorderHairline),
    );
    let (rest, strong) = if live {
        (ds.color(Color::WorkerActive), ds.color(Color::WorkerActive))
    } else {
        (ds.color(Color::Line), ds.color(Color::LineStrong))
    };
    let edges = (0..MAX_PEEKS).take(extra).map(|k| {
        div()
            .absolute()
            .top_0()
            .bottom_0()
            .left(room + step * f32::from(k) - radius)
            .w(radius + step)
            .border_t(hair)
            .border_r(hair)
            .border_b(hair)
            .border_color(rest)
            .rounded_tr(radius)
            .rounded_br(radius)
            .group_hover_style(group.clone(), move |style| style.border_color(strong))
    });
    div()
        .absolute()
        .top_0()
        .bottom_0()
        .left(relative(1.))
        .w(px(0.))
        .children(edges)
        .into_any_element()
}

/// A card of the deck: running ring, and (while interactive) the toggle that covers it.
fn card(env: &Env, item: &StepSortableItem, toggle: Option<bool>, first: &SharedString) -> Card {
    let mut card = Card::new(sub(&env.id, "card", &item.id));
    if item.running {
        card = card.running();
    }
    if let Some(open) = toggle {
        let (hub, first) = (env.hub.clone(), first.clone());
        card = card.interactive().on_click(move |_, window, _| {
            set_fanned(&hub, &first, open);
            window.refresh();
        });
    }
    card
}

fn grip_of(drag_id: SharedString, label: &str, movable: bool) -> Grip {
    Grip {
        drag_id,
        label: label.to_owned().into(),
        movable,
    }
}

/// The collapsed deck: the front card (the whole step drags as one) and its edges.
fn front(env: &Env, a: &DeckArgs<'_>, window: &mut Window, cx: &mut App) -> AnyElement {
    let first = &a.step[0];
    let pinned = is_pinned_step(a.step);
    let drag_id = step_drag_id(&first.id);
    let name = (env.labels.stack)(&first.label, a.step.len());
    let content = row(
        env,
        RowArgs {
            item: first,
            ctx: StepSortableRowContext { expanded: false, ..a.base.clone() },
            grip: Some(grip_of(drag_id.clone(), &name, !pinned)),
            marker: true,
            dim: false,
        },
        window,
        cx,
    );
    let live = a.step.iter().any(|item| item.running);
    let toggle = a.interactive.then_some(true);
    let mut front = card(env, first, toggle, &first.id).child(content);
    if live {
        front = front.running();
    }
    let front = front.into_any_element();
    let front = if a.base.lifted {
        front
    } else {
        let wrap = div().id(sub(&env.id, "front", &first.id)).w_full().child(front);
        draggable(wrap, env, &drag_id, !pinned).into_any_element()
    };
    let group: SharedString = format!("deck:{}", first.id).into();
    let edges = peeks(a.step.len() - 1, live, &group, Ds::get(cx));
    div().relative().w_full().group(group).child(edges).child(front).into_any_element()
}

/// The open deck: every card at the full row width, in order; each drags out on its own.
fn column(env: &Env, a: &DeckArgs<'_>, window: &mut Window, cx: &mut App) -> AnyElement {
    let first = &a.step[0].id;
    let gap = Ds::get(cx).len(Length::SpaceXs);
    let mut handles: Vec<FocusHandle> = Vec::new();
    let mut cards = Vec::new();
    for (index, item) in a.step.iter().enumerate() {
        let drag_id = item_drag_id(&item.id);
        let content = row(
            env,
            RowArgs {
                item,
                ctx: StepSortableRowContext { expanded: true, ..a.base.clone() },
                grip: Some(grip_of(drag_id.clone(), &item.label, is_draggable(item))),
                marker: index == 0,
                dim: env.view.mode.is_some() && env.view.item_ids.contains(&item.id),
            },
            window,
            cx,
        );
        let toggle = a.interactive.then_some(false);
        if toggle.is_some() {
            let id = (sub(&env.id, "card", &item.id), "focus");
            handles.push(window.use_keyed_state(id, cx, |_, cx| cx.focus_handle()).read(cx).clone());
        }
        let wrap = div()
            .id(sub(&env.id, "item", &item.id))
            .w_full()
            .child(card(env, item, toggle, first).child(content));
        cards.push(draggable(wrap, env, &drag_id, is_draggable(item)));
    }
    let (hub, first) = (env.hub.clone(), first.clone());
    div()
        .flex()
        .flex_col()
        .gap(gap)
        .w_full()
        .on_key_down(move |event, window, cx| {
            if event.keystroke.key == "escape"
                && handles.iter().any(|handle| handle.contains_focused(window, cx))
            {
                set_fanned(&hub, &first, false);
                cx.stop_propagation();
                window.refresh();
            }
        })
        .children(cards)
        .into_any_element()
}

pub(super) fn deck(env: &Env, a: &DeckArgs<'_>, window: &mut Window, cx: &mut App) -> AnyElement {
    if a.expanded {
        column(env, a, window, cx)
    } else {
        front(env, a, window, cx)
    }
}
