//! Auto-scroll for drags over a sidebar list (`navDropAutoScroll.ts`): a drag within 40px of the
//! list's top or bottom edge scrolls it once per frame, faster nearer the edge. Rows never
//! move: only the container scrolls.
use gpui::{Bounds, Pixels, ScrollHandle, point, px};

/// Edge band (px) where a drag scrolls the list.
pub const EDGE: f32 = 40.; // DS: navDropAutoScroll.ts:4
/// Fastest scroll per frame, reached at the very edge.
const MAX_STEP: f32 = 12.; // DS: navDropAutoScroll.ts:6

/// Which end of the list is scrolling (the band's side).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Edge {
    Start,
    End,
}

/// Scroll delta for one frame while a drag hovers at `y` over a list spanning `top`..`bottom`:
/// 0 outside the edge bands, growing to +-`MAX_STEP` at the edge itself.
pub fn step(y: f32, top: f32, bottom: f32, edge: f32) -> f32 {
    if bottom - top <= edge * 2. {
        return 0.;
    }
    if y < top + edge {
        return -(MAX_STEP * ((top + edge - y) / edge).min(1.)).ceil();
    }
    if y > bottom - edge {
        return (MAX_STEP * ((y - (bottom - edge)) / edge).min(1.)).ceil();
    }
    0.
}

/// One frame of auto-scroll: scrolls `handle` by the step for the pointer at `y` when there is
/// room that way, and returns the edge that scrolled (the band to show), if any.
pub fn tick(handle: &ScrollHandle, bounds: Bounds<Pixels>, y: f32) -> Option<Edge> {
    let (top, bottom) = (bounds.top().as_f32(), bounds.bottom().as_f32());
    let step = step(y, top, bottom, EDGE);
    let offset = handle.offset();
    let scrolled = -offset.y.as_f32();
    let max = handle.max_offset().y.as_f32();
    let room = if step < 0. {
        scrolled > 0.
    } else {
        scrolled < max
    };
    if step == 0. || !room {
        return None;
    }
    let next = (scrolled + step).clamp(0., max);
    handle.set_offset(point(offset.x, px(-next)));
    Some(if step < 0. { Edge::Start } else { Edge::End })
}
