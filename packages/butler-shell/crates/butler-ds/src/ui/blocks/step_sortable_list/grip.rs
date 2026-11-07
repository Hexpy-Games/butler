//! The reorder grip (`StepSortableGrip.tsx`): the drag source of one item or a whole 묶음. The
//! pointer drags from the grip or the card (both start the same gpui drag); the keyboard drags
//! from the grip only. While its row is lifted the grip is a static glyph.
use gpui::{
    AnyElement, App, AppContext as _, Div, ElementId, FocusHandle, InteractiveElement as _,
    IntoElement as _, MouseButton, ParentElement as _, Pixels, SharedString, Stateful,
    StatefulInteractiveElement as _, Styled as _, Window, div,
};

use super::lifted::Lifted;
use super::session::{Mode, begin, grip_key};
use super::{Env, sub};
use crate::tokens::Length;
use crate::ui::Icon;
use crate::ui::context::Ds;
use crate::ui::icon::icon_px;
use crate::ui::icon_button::IconButton;
use crate::ui::icon_slot::{IconSlot, SlotSize, SlotTone};

/// The payload of a gpui drag: the list it belongs to and the drag id (`item:<id>` or `step:<id>`).
pub(super) struct StepDrag {
    pub list: ElementId,
    pub drag_id: SharedString,
}

/// A row's grip: what it drags, its name, and whether the item may move at all.
#[derive(Clone)]
pub(super) struct Grip {
    pub drag_id: SharedString,
    pub label: SharedString,
    pub movable: bool,
}

/// `max(var(--control-height-md), var(--control-hit-target))`: the width of the grip and ⋯ slots
/// (the hit target is 0 on a pointer device).
pub(super) fn control_side(ds: &Ds) -> Pixels {
    let side = ds.len(Length::ControlHeightMd); // DS: StepSortableList.module.css:43
    if ds.compact() {
        side.max(ds.len(Length::ControlHitTarget))
    } else {
        side
    }
}

pub(super) fn grip_id(list: &ElementId, drag_id: &str) -> ElementId {
    sub(list, "grip", drag_id)
}

/// The keyboard focus handle of a grip's button (the one its control keeps under its id).
pub(super) fn grip_handle(
    list: &ElementId,
    drag_id: &str,
    window: &mut Window,
    cx: &mut App,
) -> FocusHandle {
    window
        .use_keyed_state((grip_id(list, drag_id), "focus"), cx, |_, cx| {
            cx.focus_handle()
        })
        .read(cx)
        .clone()
}

/// Makes `el` start the drag `drag_id` once the pointer moves; a no-op when it may not move.
pub(super) fn draggable(
    el: Stateful<Div>,
    env: &Env,
    drag_id: &SharedString,
    movable: bool,
) -> Stateful<Div> {
    if !movable || env.disabled {
        return el;
    }
    let (hub, list, render_item) = (env.hub.clone(), env.id.clone(), env.render_item.clone());
    let payload = StepDrag {
        list: list.clone(),
        drag_id: drag_id.clone(),
    };
    el.on_drag(payload, move |drag, offset, window, cx| {
        begin(&hub, &drag.drag_id, Mode::Pointer, window, cx);
        cx.new(|_| Lifted {
            hub: hub.clone(),
            list: list.clone(),
            render_item: render_item.clone(),
            drag_id: drag.drag_id.clone(),
            offset,
        })
    })
}

/// The grip of a row; `lifted` is the lifted copy, which shows a static glyph in the same box.
pub(super) fn grip(
    env: &Env,
    grip: &Grip,
    lifted: bool,
    window: &mut Window,
    cx: &mut App,
) -> Option<AnyElement> {
    if !grip.movable {
        return None;
    }
    let (side, glyph) = {
        let ds = Ds::get(cx);
        (control_side(ds), ds.len(Length::IconSizeMd))
    };
    let boxed = div()
        .flex()
        .flex_none()
        .items_center()
        .justify_center()
        .w(side);
    let carried =
        env.view.active_id.as_ref() == Some(&grip.drag_id) && env.view.mode == Some(Mode::Pointer);
    if lifted || carried {
        let slot = IconSlot::new()
            .size(SlotSize::Md)
            .tone(SlotTone::Tertiary)
            .child(icon_px(Icon::GripVertical, glyph));
        return Some(boxed.child(slot).into_any_element());
    }
    if env.disabled {
        return None;
    }
    env.hub.borrow_mut().rendered.insert(grip.drag_id.clone());
    let focus = grip_handle(&env.id, &grip.drag_id, window, cx);
    let button = IconButton::new(
        grip_id(&env.id, &grip.drag_id),
        (env.labels.grip)(&grip.label),
    )
    .glyph(Icon::GripVertical);
    let (hub, drag_id) = (env.hub.clone(), grip.drag_id.clone());
    let el = boxed
        .id(sub(&env.id, "grip-box", &grip.drag_id))
        .cursor_grab()
        // The grip is its own drag source; a card's toggle never sees a press on it.
        .on_mouse_down(MouseButton::Left, |_, _, cx| cx.stop_propagation())
        .on_key_down(move |event, window, cx| {
            if focus.is_focused(window)
                && grip_key(&hub, &drag_id, event.keystroke.key.as_str(), window, cx)
            {
                cx.stop_propagation();
                window.refresh();
            }
        })
        .child(button);
    Some(draggable(el, env, &grip.drag_id, true).into_any_element())
}
