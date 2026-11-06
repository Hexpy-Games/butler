//! One row of a NavDropScope: the row itself, which travels to open the slot, and the
//! indicators drawn over it (`.item[data-drop]::before/::after`, `.hint`), none of them part of
//! its layout. The outer box is never moved, so the box the drop zones test stays put.
use std::cell::RefCell;
use std::collections::HashMap;
use std::rc::Rc;
use std::time::Instant;

use gpui::{
    AnyElement, App, Bounds, Div, ElementId, InteractiveElement as _, IntoElement as _,
    ParentElement as _, Pixels, SharedString, Styled as _, Window, canvas, div, px,
};

use super::overlay::{label_height, outside_label};
use super::{NavDropPosition, NavDropTarget};
use crate::tokens::{Color, Duration as DsDuration, Easing, Length};
use crate::ui::blocks::anim::ramp;
use crate::ui::context::Ds;
use crate::ui::convert;
use crate::ui::motion::Timing;
use crate::ui::typo::{Tone, Typo};

pub(super) type Boxes = Rc<RefCell<HashMap<SharedString, Bounds<Pixels>>>>;

/// The slot and its geometry, from the tokens and the payload.
#[derive(Clone, Copy)]
pub(super) struct Slot {
    /// `--nav-drop-gap`: a row plus the row spacing (0 for an outside payload or reduced motion).
    pub(super) gap: f32,
    /// `--nav-drop-spacing`.
    pub(super) spacing: f32,
}

/// The accent fade-in of an indicator: `fade-in`/`indicator-in` over the token timing.
fn fade(id: ElementId, on: bool, fast: bool, window: &mut Window, cx: &mut App) -> f32 {
    let (timing, jump) = {
        let ds = Ds::get(cx);
        let duration = if fast {
            DsDuration::MotionFast
        } else {
            DsDuration::MotionBase
        };
        (
            Timing::token(ds, duration, Easing::MotionEaseDecelerate),
            ds.reduced_motion(),
        )
    };
    ramp(id, (f32::from(u8::from(on)), jump), &timing, window, cx)
}

/// Calls the row's `on_dwell` once after a drag has rested on it for `dwell`.
fn dwell(target: &NavDropTarget, id: &ElementId, window: &mut Window, cx: &mut App) {
    let Some(handler) = target.on_dwell.clone() else {
        return;
    };
    let active = target.drop.is_some() && !target.invalid;
    let state = window.use_keyed_state((id.clone(), "dwell"), cx, |_, _| (None::<Instant>, false));
    let now = Instant::now();
    let (since, fired) = *state.read(cx);
    if !active {
        if since.is_some() || fired {
            state.update(cx, |state, _| *state = (None, false));
        }
        return;
    }
    let since = since.unwrap_or(now);
    if now.duration_since(since) >= target.dwell && !fired {
        state.update(cx, |state, _| *state = (Some(since), true));
        window.defer(cx, move |window, cx| handler(window, cx));
    } else if !fired {
        state.update(cx, |state, _| *state = (Some(since), false));
        window.request_animation_frame();
    }
}

/// A line centred in the slot: `before` above the row, `after` below it.
fn slot_line(position: NavDropPosition, slot: Slot, opacity: f32, ds: &Ds) -> Div {
    let stroke = f32::from(ds.len(Length::BorderWidthStrong));
    let line = div()
        .absolute()
        .left(ds.len(Length::SpaceXs))
        .right(ds.len(Length::SpaceXs))
        .h(px(stroke))
        .rounded(ds.len(Length::RadiusPill))
        .bg(ds.color(Color::Accent))
        .opacity(opacity);
    if position == NavDropPosition::Before {
        line.top(px(-(slot.gap + slot.spacing + stroke) / 2.))
    } else {
        // `top: 100% + (gap + spacing - stroke) / 2`
        line.bottom(px(-(slot.gap + slot.spacing - stroke) / 2. - stroke))
    }
}

/// The inset ring and tint over the target header (`inside`, `group`, `outside`).
fn ring(box_: (f32, f32), (invalid, opacity): (bool, f32), ds: &Ds) -> Div {
    let stroke = ds.len(Length::BorderWidthStrong);
    let accent = ds.color(Color::Accent);
    let ring = div()
        .absolute()
        .top(px(box_.0))
        .h(px(box_.1))
        .left_0()
        .right_0()
        .rounded(ds.len(Length::RadiusControl))
        .opacity(opacity)
        .border(stroke);
    if invalid {
        ring.border_dashed()
            .border_color(convert::with_alpha(ds.color(Color::ColorDangerText), 0.7))
    } else {
        ring.border_color(accent)
            .bg(convert::with_alpha(accent, 0.1))
    }
}

/// The `group` hint: a caption pill at the header's end, centred on it.
fn hint(text: SharedString, box_: (f32, f32), ds: &Ds) -> Div {
    let height = label_height(ds);
    div()
        .absolute()
        .top(px(box_.0 + box_.1 / 2. - height / 2.))
        .right(ds.len(Length::SpaceSm))
        .px(ds.len(Length::SpaceSm))
        .py(ds.len(Length::SpaceXs))
        .rounded(ds.len(Length::RadiusControl))
        .bg(ds.color(Color::Surface))
        .text_color(ds.color(Color::AccentText))
        .child(Typo::caption(text).tone(Tone::Inherit))
}

/// What a row needs from its scope.
#[derive(Clone, Copy)]
pub(super) struct Ctx<'a> {
    pub(super) scope: &'a ElementId,
    pub(super) slot: Slot,
    pub(super) shift: bool,
    pub(super) boxes: &'a Boxes,
}

/// How far the row has travelled down to open the slot, eased over `--motion-base`.
fn travelled(id: &ElementId, goal: f32, window: &mut Window, cx: &mut App) -> f32 {
    let (timing, jump) = {
        let ds = Ds::get(cx);
        (
            Timing::token(ds, DsDuration::MotionBase, Easing::MotionEaseStandard),
            ds.reduced_motion(),
        )
    };
    ramp((id.clone(), "shift"), (goal, jump), &timing, window, cx)
}

/// The indicators over a row for its drop: the slot line, or the ring (and the group hint).
fn indicators(target: &NavDropTarget, (ctx, opacity): (&Ctx, f32), ds: &Ds) -> Vec<AnyElement> {
    let Some(position) = target.drop else {
        return Vec::new();
    };
    let header = target.indicator.unwrap_or((0., 0.));
    let header = whole_if_unmeasured(header, ctx.boxes, &target.key);
    match position {
        NavDropPosition::Before | NavDropPosition::After => {
            vec![slot_line(position, ctx.slot, opacity, ds).into_any_element()]
        }
        NavDropPosition::Inside | NavDropPosition::Group | NavDropPosition::Outside => {
            let invalid = position == NavDropPosition::Outside && target.invalid;
            let mut layers = vec![ring(header, (invalid, opacity), ds).into_any_element()];
            if let (NavDropPosition::Group, Some(text)) = (position, target.hint.clone()) {
                layers.push(hint(text, header, ds).into_any_element());
            }
            layers
        }
    }
}

/// Records the row's layout box. A moved box (the page scrolled, the list resized) is drawn
/// against once more: the drop label and the auto-scroll band are placed from it.
fn recorder(key: SharedString, boxes: Boxes) -> gpui::Canvas<Bounds<Pixels>> {
    canvas(
        |bounds, _, _| bounds,
        move |_, bounds, window, _| {
            let moved = boxes.borrow_mut().insert(key.clone(), bounds) != Some(bounds);
            if moved {
                window.request_animation_frame();
            }
        },
    )
}

pub(super) fn render(
    mut target: NavDropTarget,
    ctx: &Ctx,
    window: &mut Window,
    cx: &mut App,
) -> AnyElement {
    let id: ElementId = (ctx.scope.clone(), target.key.clone()).into();
    dwell(&target, &id, window, cx);
    let before = target.drop == Some(NavDropPosition::Before);
    let goal = if ctx.shift || before {
        ctx.slot.gap
    } else {
        0.
    };
    let shift = travelled(&id, goal, window, cx);
    let drop = target.drop;
    let opacity = fade(
        (id.clone(), "indicator").into(),
        drop.is_some(),
        !matches!(drop, Some(NavDropPosition::Before | NavDropPosition::After)),
        window,
        cx,
    );
    let ds = Ds::get(cx);
    let layers = indicators(&target, (ctx, opacity), ds);
    let anchor = format!("nav-drop:{}", target.key);
    let mut inner = div()
        .id(id.clone())
        .debug_selector(move || anchor.clone())
        .relative()
        .top(px(shift))
        .opacity(if target.dragging { 0.5 } else { 1. }); // DS: NavDropTarget.module.css:25
    for attach in std::mem::take(&mut target.attach) {
        inner = attach(inner);
    }
    let inner = inner
        .child(std::mem::replace(
            &mut target.child,
            div().into_any_element(),
        ))
        .children(layers);
    let record = recorder(target.key.clone(), ctx.boxes.clone())
        .absolute()
        .size_full();
    let mut outer = div().relative().w_full().child(record).child(inner);
    if let (Some(NavDropPosition::Outside), Some(text)) = (drop, target.hint.take()) {
        let measured = ctx.boxes.borrow().get(&target.key).copied();
        if let Some(row) = measured {
            let (top, height) = target.indicator.unwrap_or((0., f32::from(row.size.height)));
            let middle = row.top().as_f32() + top + height / 2.;
            outer = outer.child(outside_label(
                text,
                (row, middle),
                target.invalid,
                window,
                ds,
            ));
        }
    }
    outer.into_any_element()
}

/// The header box in px from the item's top; the whole measured item when none was given.
fn whole_if_unmeasured(header: (f32, f32), boxes: &Boxes, key: &SharedString) -> (f32, f32) {
    if header.1 > 0. {
        return header;
    }
    let height = boxes
        .borrow()
        .get(key)
        .map_or(0., |bounds| bounds.size.height.as_f32());
    (0., height)
}
