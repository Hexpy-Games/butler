//! The timeline dot of a work activity (`.marker`): a 7px ring on the line, filled and pulsing
//! on the newest activity of running work (`work-activity-live-pulse`).
use gpui::{AnyElement, App, ElementId, IntoElement as _, Styled as _, Window, div, px};

use crate::tokens::{Color, Duration as DsDuration, Easing, Length};
use crate::ui::context::Ds;
use crate::ui::convert;
use crate::ui::motion::Loop;

/// The dot's side. // DS: WorkActivityBlock.module.css:77
pub(super) const SIDE: f32 = 7.;

/// The live dot's opacity `phase` (0 to 1) into a pulse: 100% at both ends, 35% at the middle,
/// each half on the standard ease. // DS: WorkActivityBlock.module.css:102
fn pulse(phase: f32, ease: impl Fn(f32) -> f32) -> f32 {
    let half = if phase < 0.5 {
        ease(phase * 2.)
    } else {
        1. - ease((phase - 0.5) * 2.)
    };
    1. - 0.65 * half
}

/// The dot; `live` fills it and pulses it. Its place on the line is the caller's.
pub(super) fn dot(
    id: impl Into<ElementId>,
    live: bool,
    window: &mut Window,
    cx: &mut App,
) -> AnyElement {
    let id = id.into();
    let started = window.use_keyed_state((id, "pulse"), cx, |_, cx| cx.background_executor().now());
    let now = cx.background_executor().now();
    let begun = *started.read(cx);
    let (opacity, running) = {
        let ds = Ds::get(cx);
        let period = ds.duration(DsDuration::MotionLivePulse).as_secs_f32();
        let ease = convert::easing(ds.tokens().ease(Easing::MotionEaseStandard));
        let running = live && Loop::Decorative.runs(ds);
        let phase = (now.saturating_duration_since(begun).as_secs_f32() / period).fract();
        (if running { pulse(phase, ease) } else { 1. }, running)
    };
    if running {
        window.request_animation_frame();
    }
    let ds = Ds::get(cx);
    let dot = div()
        .flex_none()
        .size(px(SIDE))
        .rounded(ds.len(Length::RadiusPill));
    if live {
        let ink = ds.color(Color::TextPrimary);
        dot.border(px(1.))
            .border_color(ink)
            .bg(ink)
            .opacity(opacity)
            .into_any_element()
    } else {
        dot.border(px(1.))
            .border_color(ds.color(Color::LineStrong))
            .bg(ds.color(Color::Surface))
            .into_any_element()
    }
}
