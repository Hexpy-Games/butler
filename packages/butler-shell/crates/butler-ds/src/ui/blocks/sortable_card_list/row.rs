//! One card of a SortableCardList (`SortableCardItem.tsx`): `[grip] [leading] [title ... meta /
//! description] [remove]` on a small-padded Card. The live row also carries the drag source,
//! the keyboard step, the row recorder and the drop indicator; the lifted copy has a static
//! grip and no remove button.
use gpui::{
    AnyElement, App, AppContext as _, Div, FocusHandle, InteractiveElement as _, IntoElement as _,
    ParentElement as _, Pixels, Point, Stateful, StatefulInteractiveElement as _, Styled as _,
    Window, div, point, px,
};

use super::drag::{Drag, Lifted, recorder, step};
use super::{Env, Slot, SortableCardItem, copy, sub};
use crate::tokens::Length;
use crate::ui::Icon;
use crate::ui::card::{Card, CardPadding};
use crate::ui::context::Ds;
use crate::ui::icon::icon_px;
use crate::ui::icon_button::IconButton;
use crate::ui::icon_slot::{IconSlot, SlotSize, SlotTone};
use crate::ui::layout::Space;
use crate::ui::separator::{Separator, SeparatorTone};
use crate::ui::typo::{Tone, Typo};

/// The dragged card stays in place at this opacity (`.dragging`).
const DRAGGING: f32 = 0.42; // DS: SortableCardList.module.css:104
/// A Card's 1px border.
const CARD_BORDER: f32 = 1.; // DS: Card.module.css:2

/// `var(--icon-button-size, --control-height-md)`, at least the hit target on touch.
fn control_side(ds: &Ds) -> Pixels {
    let side = ds.len(Length::ControlHeightMd);
    if ds.compact() {
        side.max(ds.len(Length::ControlHitTarget))
    } else {
        side
    }
}

/// The grip's box, pulled back by `--space-1` (`.handle` margin).
fn grip_box(ds: &Ds) -> Div {
    let pull = ds.len(Length::Space1);
    div()
        .flex()
        .flex_none()
        .items_center()
        .justify_center()
        .size(control_side(ds))
        .ml(-pull)
        .mt(-pull)
}

/// The lifted copy's grip: the same box without the button.
pub(super) fn static_grip(ds: &Ds) -> AnyElement {
    let slot = IconSlot::new()
        .size(SlotSize::Md)
        .tone(SlotTone::Tertiary)
        .child(icon_px(Icon::GripVertical, ds.len(Length::IconSizeMd)));
    grip_box(ds).child(slot).into_any_element()
}

/// The element slots of an item, built before the card (they need the window, the card only
/// the theme).
pub(super) struct Nodes {
    title: Option<AnyElement>,
    description: Option<AnyElement>,
    actions: Option<AnyElement>,
}

impl Nodes {
    pub(super) fn build(item: &SortableCardItem, window: &mut Window, cx: &mut App) -> Self {
        let mut slot = |slot: &Option<Slot>| slot.as_ref().map(|slot| slot.build(window, cx));
        Self {
            title: slot(&item.title_element),
            description: slot(&item.description_element),
            actions: slot(&item.actions),
        }
    }
}

/// The card around `grip`, the item's content and an optional remove button.
pub(super) fn card(
    item: &SortableCardItem,
    nodes: Nodes,
    grip: AnyElement,
    remove: Option<AnyElement>,
    ds: &Ds,
) -> AnyElement {
    let (gap, tight) = (ds.len(Length::Space2), ds.len(Length::SpaceXs));
    let leading = item.leading.map(|glyph| {
        div()
            .flex()
            .flex_none()
            .items_center()
            .justify_center()
            .min_w(ds.len(Length::Space6))
            .text_color(ds.color(crate::tokens::Color::TextTertiary))
            .child(icon_px(glyph, ds.len(Length::IconSizeMd)))
    });
    let title_row = div()
        .flex()
        .items_center()
        .gap(gap)
        .min_w_0()
        .child(div().flex_auto().min_w_0().child(match nodes.title {
            Some(title) => title,
            None => Typo::body(item.title.clone()).truncate().into_any_element(),
        }))
        .children(item.meta.clone().map(|meta| {
            div()
                .flex_none()
                .child(Typo::caption(meta).tone(Tone::Tertiary).truncate())
        }));
    let content = div()
        .flex()
        .flex_col()
        .flex_auto()
        .min_w_0()
        .gap(tight)
        .child(title_row)
        .children(nodes.description.or_else(|| {
            item.description.clone().map(|text| {
                Typo::caption(text)
                    .tone(Tone::Secondary)
                    .truncate()
                    .into_any_element()
            })
        }));
    let row = div()
        .flex()
        .items_start()
        .w_full()
        .min_w_0()
        .gap(gap)
        .child(grip)
        .children(leading)
        .child(content)
        .children(
            nodes
                .actions
                .map(|actions| div().flex_none().child(actions)),
        )
        .children(remove);
    let id = (gpui::ElementId::from(item.id.clone()), "card");
    Card::new(id)
        .padding(CardPadding::Sm)
        .child(row)
        .into_any_element()
}

/// The grip makes the card draggable by pointer (a gpui drag) and movable by the arrow keys.
fn movable(
    grip: Stateful<Div>,
    env: &Env,
    item: &SortableCardItem,
    focus: FocusHandle,
    shift: Point<Pixels>,
) -> Stateful<Div> {
    let (hub, id) = (env.hub.clone(), item.id.clone());
    let (keys, key_id) = (hub.clone(), id.clone());
    let (lifted, list) = (item.clone(), env.id.clone());
    grip.cursor_grab()
        .on_key_down(move |event, window, cx| {
            if !focus.is_focused(window) {
                return;
            }
            let up = match event.keystroke.key.as_str() {
                "up" => true,
                "down" => false,
                _ => return,
            };
            step(&keys, &key_id, up, window, cx);
            cx.stop_propagation();
            window.refresh();
        })
        .on_drag(Drag { list, id }, move |drag, _, _, cx| {
            let width = {
                let mut session = hub.borrow_mut();
                session.active = Some(drag.id.clone());
                session.over = None;
                session.rows.get(&drag.id).map(|bounds| bounds.size.width)
            };
            cx.new(|_| Lifted {
                item: lifted.clone(),
                width,
                shift,
            })
        })
}

/// The drop indicator: a `Separator` (`tone="accent"`, `space="xs"`) centred in the gap before
/// the row, or after it when the card moves down past it.
fn indicator(after: bool, ds: &Ds) -> Div {
    let offset = -((ds.len(Length::Space2) + Space::Xs.px(ds)) / 2.);
    let line = div().absolute().left_0().right_0();
    let line = if after {
        line.bottom(offset)
    } else {
        line.top(offset)
    };
    line.child(
        Separator::new()
            .space(Space::Xs)
            .tone(SeparatorTone::Accent),
    )
}

/// The live row of `item`.
pub(super) fn live(
    env: &Env,
    item: &SortableCardItem,
    window: &mut Window,
    cx: &mut App,
) -> AnyElement {
    let label = item.label.clone().unwrap_or_else(|| item.title.clone());
    let grip_id = sub(&env.id, "grip", &item.id);
    let focus = window
        .use_keyed_state((grip_id.clone(), "focus"), cx, |_, cx| cx.focus_handle())
        .read(cx)
        .clone();
    let (dragging, line) = {
        let session = env.hub.borrow();
        let line = session
            .indicator()
            .filter(|(over, _)| **over == item.id)
            .map(|(_, after)| after);
        (session.active.as_ref() == Some(&item.id), line)
    };
    let nodes = Nodes::build(item, window, cx);
    let ds = Ds::get(cx);
    let mut button =
        IconButton::new(grip_id, copy::reorder(env.lang, &label)).glyph(Icon::GripVertical);
    if env.disabled {
        button = button.disabled();
    }
    let mut grip = grip_box(ds)
        .id(sub(&env.id, "grip-box", &item.id))
        .child(button);
    if !env.disabled {
        let inset = px(CARD_BORDER) + ds.len(Length::Space2) - ds.len(Length::Space1);
        grip = movable(grip, env, item, focus, point(inset, inset));
    }
    let remove = env.on_remove.clone().map(|on_remove| {
        let id = item.id.clone();
        let mut button = IconButton::new(
            sub(&env.id, "remove", &item.id),
            copy::remove(env.lang, &label),
        )
        .glyph(Icon::X)
        .on_click(move |_, window, cx| on_remove(&id, window, cx));
        if env.disabled {
            button = button.disabled();
        }
        button.into_any_element()
    });
    let mut wrap = div().relative().w_full().min_w_0();
    if dragging {
        wrap = wrap.opacity(DRAGGING);
    }
    wrap.child(card(item, nodes, grip.into_any_element(), remove, ds))
        .child(recorder(&env.hub, &item.id))
        .children(line.map(|after| indicator(after, ds)))
        .into_any_element()
}
