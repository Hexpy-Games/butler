//! The field's segments (TimePicker.tsx): one spinbutton per part. Digits type into the focused
//! segment, the arrows step it, Left/Right move between segments, Home/End set its ends and a
//! letter sets the day period. Enter, or Alt+Down, opens the wheels.
use std::rc::Rc;

use gpui::{
    AnyElement, App, Entity, FocusHandle, InteractiveElement as _, IntoElement as _, MouseButton,
    ParentElement as _, Styled as _, Window, div, px,
};

use super::model::{
    Parts, SEPARATOR, Segment, display, home_end, period_letter, set_period, step, type_digit,
};
use super::{Ctx, sub};
use crate::tokens::{Color, Length, Number};
use crate::ui::context::Ds;
use crate::ui::focus;

/// The digits typed into a segment so far, valid while the value is still what they made.
#[derive(Default)]
pub(super) struct Pending {
    segment: Option<Segment>,
    text: String,
    at: Option<Parts>,
}

pub(super) fn segment_handle(
    id: &gpui::ElementId,
    segment: Segment,
    window: &mut Window,
    cx: &mut App,
) -> FocusHandle {
    window
        .use_keyed_state(sub(id, "segment", segment.key()), cx, |_, cx| {
            cx.focus_handle()
        })
        .read(cx)
        .clone()
}

pub(super) fn pending_state(
    id: &gpui::ElementId,
    window: &mut Window,
    cx: &mut App,
) -> Entity<Pending> {
    window.use_keyed_state(sub(id, "pending", "digits"), cx, |_, _| Pending::default())
}

/// The segments, in the language's order, with the separator between hour and minute.
pub(super) fn segments(
    ctx: &Ctx,
    handles: &Rc<Vec<FocusHandle>>,
    pending: &Entity<Pending>,
    disabled: bool,
    window: &Window,
    ds: &Ds,
) -> AnyElement {
    let order = ctx.layout.order;
    let last = order.len().saturating_sub(1);
    let items = order.iter().enumerate().map(|(at, segment)| {
        let separated = *segment == Segment::Minute && at > 0 && order[at - 1] == Segment::Hour;
        let mut wrap = div().flex().items_center();
        if *segment == Segment::Period {
            // The period stands apart from "04:00", on the side it is written.
            wrap = if at == 0 {
                wrap.mr(ds.len(Length::SpaceXs))
            } else if at == last {
                wrap.ml(ds.len(Length::SpaceXs))
            } else {
                wrap
            };
        }
        wrap.children(separated.then(|| {
            div()
                .text_color(ds.color(Color::TextTertiary))
                .child(SEPARATOR)
        }))
        .child(segment_view(
            ctx, handles, pending, at, disabled, window, ds,
        ))
    });
    div()
        .flex()
        .items_center()
        .min_w_0()
        .children(items)
        .into_any_element()
}

fn segment_view(
    ctx: &Ctx,
    handles: &Rc<Vec<FocusHandle>>,
    pending: &Entity<Pending>,
    at: usize,
    disabled: bool,
    window: &Window,
    ds: &Ds,
) -> AnyElement {
    let segment = ctx.layout.order[at];
    let handle = handles[at].clone();
    let text = display(segment, ctx.cycle, ctx.parts, &ctx.layout);
    let radius = ds.len(Length::SpaceXs) / ds.number(Number::UiScale); // DS: TimePicker.module.css:62
    let mut view = div()
        .px(px(3.)) // DS: TimePicker.module.css:60
        .py(px(2.))
        .rounded(radius)
        .cursor_default();
    if disabled {
        return view.child(text).into_any_element();
    }
    if handle.is_focused(window) {
        view = view.bg(ds.color(Color::SelectionStrong));
    }
    let clear = pending.clone();
    view.track_focus(&focus::tab_stop(&handle, true))
        .on_mouse_down(MouseButton::Left, move |_, _, cx| {
            clear.update(cx, |p, _| *p = Pending::default());
        })
        .on_key_down(key_handler(
            ctx.clone(),
            handles.clone(),
            pending.clone(),
            at,
        ))
        .child(text)
        .into_any_element()
}

fn key_handler(
    ctx: Ctx,
    handles: Rc<Vec<FocusHandle>>,
    pending: Entity<Pending>,
    at: usize,
) -> impl Fn(&gpui::KeyDownEvent, &mut Window, &mut App) + 'static {
    let segment = ctx.layout.order[at];
    move |event, window, cx| {
        let keystroke = &event.keystroke;
        if keystroke.modifiers.platform || keystroke.modifiers.control {
            return;
        }
        let key = keystroke.key.as_str();
        let clear = |cx: &mut App| pending.update(cx, |p, _| *p = Pending::default());
        let focus_at = |to: Option<usize>, window: &mut Window, cx: &mut App| {
            if let Some(handle) = to.and_then(|to| handles.get(to)) {
                window.focus(handle, cx);
            }
        };
        let (cycle, parts) = (ctx.cycle, ctx.parts);
        let handled = match key {
            "enter" => {
                ctx.popover.set_open(true, window, cx);
                true
            }
            "down" if keystroke.modifiers.alt => {
                ctx.popover.set_open(true, window, cx);
                true
            }
            "up" | "down" => {
                clear(cx);
                (ctx.set)(
                    step(segment, cycle, parts, if key == "up" { 1 } else { -1 }),
                    window,
                    cx,
                );
                true
            }
            "right" => {
                clear(cx);
                focus_at(Some(at + 1), window, cx);
                true
            }
            "left" => {
                clear(cx);
                focus_at(at.checked_sub(1), window, cx);
                true
            }
            "home" | "end" => {
                (ctx.set)(home_end(segment, cycle, parts, key == "home"), window, cx);
                true
            }
            "backspace" | "delete" => {
                clear(cx);
                true
            }
            _ => type_key(&ctx, &pending, &handles, at, key, window, cx),
        };
        if handled {
            cx.stop_propagation();
        }
    }
}

/// A letter on the period, or a digit on the hour and minute. Whether the key was one of them.
fn type_key(
    ctx: &Ctx,
    pending: &Entity<Pending>,
    handles: &Rc<Vec<FocusHandle>>,
    at: usize,
    key: &str,
    window: &mut Window,
    cx: &mut App,
) -> bool {
    let segment = ctx.layout.order[at];
    if segment == Segment::Period {
        let Some(pm) = period_letter(&ctx.layout.periods, key) else {
            return false;
        };
        (ctx.set)(set_period(ctx.parts, pm), window, cx);
        return true;
    }
    let digit = key
        .chars()
        .next()
        .filter(|_| key.len() == 1)
        .and_then(|c| c.to_digit(10));
    let Some(digit) = digit else {
        return false;
    };
    let typed = {
        let held = pending.read(cx);
        let live = held.segment == Some(segment) && held.at == Some(ctx.parts);
        let text = if live { held.text.as_str() } else { "" };
        type_digit(
            segment,
            ctx.cycle,
            ctx.parts,
            text,
            i32::try_from(digit).unwrap_or(0),
        )
    };
    pending.update(cx, |p, _| {
        *p = Pending {
            segment: Some(segment),
            text: typed.pending,
            at: Some(typed.parts),
        };
    });
    (ctx.set)(typed.parts, window, cx);
    if typed.advance
        && let Some(next) = handles.get(at + 1)
    {
        window.focus(next, cx);
    }
    true
}
