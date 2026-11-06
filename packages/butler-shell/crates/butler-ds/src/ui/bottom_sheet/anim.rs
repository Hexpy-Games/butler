//! A sheet's motion (BottomSheet.module.css `sheet-slide-in`, `sheet-fade-in`, `sheet-slide-out`,
//! `sheet-fade-out` and the backdrop's). gpui has no element transform, so the translate is the
//! surface's `top` while it is positioned relative to its place.
use gpui::{
    AnyElement, App, Entity, InteractiveElement as _, IntoElement as _, ParentElement as _,
    Styled as _, Window, div, px,
};

use super::state::SheetState;
use crate::tokens::{Color, Duration as DsDuration, Easing};
use crate::ui::context::Ds;
use crate::ui::motion::{Timing, Tween};
use crate::ui::overlay::lifecycle::Phase;

/// What the animation needs besides the phase.
pub(crate) struct Frame {
    pub state: Entity<SheetState>,
    /// The window's height: `translateY(100%)` of a surface not measured yet.
    pub window_height: f32,
}

/// `content` entering or leaving the bottom edge; nothing when closed. Enter slides up from
/// 100% over `--motion-deliberate` on the settle curve while fading in over `--motion-fast`;
/// exit slides from where the surface was dragged to 100% and fades over `--motion-exit-slow`
/// on the accelerate curve. Reduced motion only fades.
pub(crate) fn animate(
    id: &str,
    phase: Phase,
    frame: &Frame,
    content: AnyElement,
    window: &mut Window,
    cx: &mut App,
) -> Option<AnyElement> {
    let now = cx.background_executor().now();
    let (offset, easing) = frame
        .state
        .update(cx, |state, cx| state.offset(now, Ds::get(cx)));
    if easing {
        window.request_animation_frame();
    }
    let height = frame
        .state
        .read(cx)
        .surface
        .bounds()
        .map_or(frame.window_height, |b| f32::from(b.size.height));
    let from = frame.state.read(cx).held_offset();
    let ds = Ds::get(cx);
    let reduced = ds.reduced_motion();
    match phase {
        Phase::Closed => None,
        Phase::Open { key } => {
            let slide = Timing::token(ds, DsDuration::MotionDeliberate, Easing::MotionEaseSettle);
            if reduced {
                // `animation-name: sheet-fade-in` keeps the first duration and curve of the list.
                return Some(
                    Tween::new(
                        format!("{id}-in-{key}"),
                        div().relative().top(px(offset)).child(content),
                        slide,
                        gpui::Styled::opacity,
                    )
                    .into_any_element(),
                );
            }
            let fade = Timing::token(ds, DsDuration::MotionFast, Easing::MotionEaseStandard);
            let moving = Tween::new(
                format!("{id}-slide-{key}"),
                div().relative().child(content),
                slide,
                move |el, t| el.top(px(if t < 1. { height * (1. - t) } else { offset })),
            );
            Some(
                Tween::new(
                    format!("{id}-in-{key}"),
                    div().child(moving),
                    fade,
                    gpui::Styled::opacity,
                )
                .into_any_element(),
            )
        }
        Phase::Exiting { key, .. } => {
            let out = Timing::token(ds, DsDuration::MotionExitSlow, Easing::MotionEaseAccelerate);
            Some(
                Tween::new(
                    format!("{id}-out-{key}"),
                    div().relative().child(content),
                    out,
                    move |el, t| {
                        let top = if reduced {
                            from
                        } else {
                            from + (height - from) * t
                        };
                        el.top(px(top)).opacity(1. - t)
                    },
                )
                .into_any_element(),
            )
        }
    }
}

/// The backdrop (`--dialog-overlay-bg`) over the whole window: it fades in over `--motion-base`
/// on the standard curve and out over `--motion-exit-slow` on the accelerate curve.
pub(crate) fn backdrop(id: &str, phase: Phase, size: (f32, f32), ds: &Ds) -> Option<AnyElement> {
    let scrim = div()
        .w(px(size.0))
        .h(px(size.1))
        .bg(ds.color(Color::DialogOverlayBg))
        .occlude();
    match phase {
        Phase::Closed => None,
        Phase::Open { key } => {
            let timing = Timing::token(ds, DsDuration::MotionBase, Easing::MotionEaseStandard);
            Some(
                Tween::new(format!("{id}-in-{key}"), scrim, timing, |el, t| {
                    el.opacity(t)
                })
                .into_any_element(),
            )
        }
        Phase::Exiting { key, .. } => {
            let timing =
                Timing::token(ds, DsDuration::MotionExitSlow, Easing::MotionEaseAccelerate);
            Some(
                Tween::new(format!("{id}-out-{key}"), scrim, timing, |el, t| {
                    el.opacity(1. - t)
                })
                .into_any_element(),
            )
        }
    }
}
