//! A value that eases toward a target on a token timing (a CSS transition of one property),
//! kept in window state between frames.
use gpui::{App, ElementId, Window};

use crate::ui::motion::{Ramp, Timing};

/// Where the value `id` is now, heading for `target`. A new target restarts from the current
/// value; `jump` lands on it at once. Asks for frames while the value moves.
pub fn ramp(
    id: impl Into<ElementId>,
    (target, jump): (f32, bool),
    timing: &Timing,
    window: &mut Window,
    cx: &mut App,
) -> f32 {
    let state = window.use_keyed_state((id.into(), "ramp"), cx, |_, _| Ramp::at(target));
    let now = cx.background_executor().now();
    let (value, moving) = state.update(cx, |ramp, _| {
        ramp.retarget(target, now, jump);
        ramp.sample(now, timing.duration, &|x| timing.ease(x))
    });
    if moving {
        window.request_animation_frame();
    }
    value
}
