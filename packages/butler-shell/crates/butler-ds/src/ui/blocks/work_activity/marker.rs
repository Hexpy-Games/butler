//! The timeline dot of a work activity (`.marker`): a 7px ring on the line, filled and pulsing
//! on the newest activity of running work (`work-activity-live-pulse`).
use gpui::{AnyElement, App, ElementId, IntoElement as _, Styled as _, Window, div, px};

use crate::tokens::{Color, Duration as DsDuration, Easing, Length};
use crate::ui::context::Ds;
use crate::ui::motion::{Loop, Timing, mounted_at};

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
    let start = mounted_at((id, "pulse"), window, cx);
    let ds = Ds::get(cx);
    let dot = div()
        .flex_none()
        .size(px(SIDE))
        .rounded(ds.len(Length::RadiusPill));
    if live {
        let ink = ds.color(Color::TextPrimary);
        let dot = dot.border(px(1.)).border_color(ink).bg(ink);
        if Loop::Decorative.runs(ds) {
            let timing = Timing::token(ds, DsDuration::MotionLivePulse, Easing::MotionEaseStandard);
            let points: Vec<_> = (0..23)
                .map(|k| {
                    let x = k as f32 / 22.;
                    (x, (1. - pulse(x, |p| timing.ease(p))) / 0.65)
                })
                .collect();
            dot.motion(gpui::LayerMotion {
                repeat: gpui::MotionRepeat::Loop,
                opacity: (1., 0.35),
                easing: gpui::MotionEasing::linear(&points),
                ..timing.motion(start)
            })
            .into_any_element()
        } else {
            dot.into_any_element()
        }
    } else {
        dot.border(px(1.))
            .border_color(ds.color(Color::LineStrong))
            .bg(ds.color(Color::Surface))
            .into_any_element()
    }
}
