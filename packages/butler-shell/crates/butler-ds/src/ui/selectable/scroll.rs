//! Drag-selection auto-scroll, as Electron 44 measured: inside a 20 px belt at the scroll port's top or
//! bottom edge, or past it, the list scrolls (distance past the edge + 27) px per 60 Hz frame; it stops
//! at the scope's own edge (selection stays inside one message).
use super::State;
use gpui::{App, Bounds, Entity, Pixels, Window, point, px};
use std::time::Instant;

const BELT: f32 = 20.;
const BASE: f32 = 27.;
const HZ: f32 = 60.;

pub(super) fn autoscroll(
    state: &Entity<State>,
    bounds: Bounds<Pixels>,
    window: &mut Window,
    cx: &mut App,
) {
    let port = window.content_mask().bounds;
    let p = window.mouse_position();
    let (down, d) = if p.y > port.bottom() - px(BELT) && bounds.bottom() > port.bottom() {
        (true, p.y - port.bottom())
    } else if p.y < port.top() + px(BELT) && bounds.top() < port.top() {
        (false, port.top() - p.y)
    } else {
        state.update(cx, |s, _| s.scrolled_at = None);
        return;
    };
    let now = Instant::now();
    let dt = state.update(cx, |s, _| {
        let dt = s
            .scrolled_at
            .map_or(1. / HZ, |at| now.duration_since(at).as_secs_f32())
            .min(2. / HZ);
        s.scrolled_at = Some(now);
        dt
    });
    let step = (d + px(BASE)) * HZ * dt;
    window.request_autoscroll(if down {
        Bounds::from_corners(
            point(bounds.left(), port.bottom()),
            point(bounds.right(), (port.bottom() + step).min(bounds.bottom())),
        )
    } else {
        Bounds::from_corners(
            point(bounds.left(), (port.top() - step).max(bounds.top())),
            point(bounds.right(), port.top()),
        )
    });
    state.update(cx, |s, _| s.drag(p));
    crate::ui::motion::input_frame(window);
}
