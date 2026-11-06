//! Motion of a row that just arrived (`message-enter`, `message-delivered`): the clock of a
//! row starts when it first renders; the row's key makes a re-created row replay it.
use std::time::Instant;

use gpui::{App, ElementId, Window};

use crate::tokens::{Duration as DsDuration, Easing};
use crate::ui::context::Ds;
use crate::ui::convert;

/// How far an entrance has come, 0 to 1, eased; asks for frames until it is done. `id` keys the
/// clock, which starts at the first render.
pub(crate) fn progress(
    id: impl Into<ElementId>,
    (duration, ease): (DsDuration, Easing),
    window: &mut Window,
    cx: &mut App,
) -> f32 {
    let start = window.use_keyed_state((id.into(), "entered"), cx, |_, cx| {
        cx.background_executor().now()
    });
    let (length, curve) = {
        let ds = Ds::get(cx);
        (ds.duration(duration), ds.tokens().ease(ease))
    };
    let begun: Instant = *start.read(cx);
    let t = cx
        .background_executor()
        .now()
        .saturating_duration_since(begun)
        .as_secs_f32()
        / length.as_secs_f32().max(f32::EPSILON);
    if t < 1. {
        window.request_animation_frame();
    }
    convert::ease_at(curve, t.clamp(0., 1.))
}
