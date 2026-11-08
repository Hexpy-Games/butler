//! The retained entrance and delivered phase of a message, keyed at its first render.
use crate::tokens::{Duration as DsDuration, Easing};
use crate::ui::context::Ds;
use crate::ui::motion::{Timing, Transition, keyed};
use gpui::{App, ElementId, Window};

/// The phase and timing of a keyed message entrance.
pub(crate) fn progress(
    id: impl Into<ElementId>,
    (duration, ease): (DsDuration, Easing),
    window: &mut Window,
    cx: &mut App,
) -> (Transition, Timing) {
    let timing = Timing::token(Ds::get(cx), duration, ease);
    (
        keyed((id.into(), "entered"), 0., 1., &timing, window, cx),
        timing,
    )
}
