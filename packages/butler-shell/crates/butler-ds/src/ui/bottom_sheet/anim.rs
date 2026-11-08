//! A sheet's motion (BottomSheet.module.css `sheet-slide-in`, `sheet-fade-in`, `sheet-slide-out`,
//! `sheet-fade-out` and the backdrop's), retained on the animation clock.
use gpui::{
    AnyElement, App, Entity, InteractiveElement as _, IntoElement as _, ParentElement as _,
    Styled as _, Window, div, point, px,
};

use super::state::SheetState;
use crate::tokens::{Color, Duration as DsDuration, Easing};
use crate::ui::context::Ds;
use crate::ui::motion::{Props, Timing, transition};
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
    let (key, entering) = match phase {
        Phase::Closed => return None,
        Phase::Open { key } => (key, true),
        Phase::Exiting { key, .. } => (key, false),
    };
    let slide = if entering {
        Timing::token(ds, DsDuration::MotionDeliberate, Easing::MotionEaseSettle)
    } else {
        Timing::token(ds, DsDuration::MotionExitSlow, Easing::MotionEaseAccelerate)
    };
    let fade = if reduced || !entering {
        slide
    } else {
        Timing::token(ds, DsDuration::MotionFast, Easing::MotionEaseStandard)
    };
    let target = if entering { 1. } else { 0. };
    let value = transition(
        format!("{id}-slide-{key}"),
        (target, reduced),
        &slide,
        window,
        cx,
    );
    let props = Props {
        offset: Some((
            point(px(0.), px(height)),
            point(px(0.), px(if entering { 0. } else { from })),
        )),
        ..Default::default()
    };
    let mut moving = if reduced {
        div()
            .relative()
            .top(px(if entering { offset } else { from }))
            .child(content)
    } else {
        value.apply(div().relative().child(content), &slide, &props)
    };
    if entering && !value.moving(&slide) {
        moving = moving.top(px(offset));
    }
    Some(
        transition(format!("{id}-in-{key}"), (target, false), &fade, window, cx)
            .apply(
                div().child(moving),
                &fade,
                &Props {
                    opacity: Some((0., 1.)),
                    ..Default::default()
                },
            )
            .into_any_element(),
    )
}

/// The backdrop (`--dialog-overlay-bg`) over the whole window: it fades in over `--motion-base`
/// on the standard curve and out over `--motion-exit-slow` on the accelerate curve.
pub(crate) fn backdrop(
    id: &str,
    phase: Phase,
    size: (f32, f32),
    window: &mut Window,
    cx: &mut App,
) -> Option<AnyElement> {
    let ds = Ds::get(cx);
    let scrim = div()
        .w(px(size.0))
        .h(px(size.1))
        .bg(ds.color(Color::DialogOverlayBg))
        .occlude();
    let (key, entering) = match phase {
        Phase::Closed => return None,
        Phase::Open { key } => (key, true),
        Phase::Exiting { key, .. } => (key, false),
    };
    let timing = if entering {
        Timing::token(ds, DsDuration::MotionBase, Easing::MotionEaseStandard)
    } else {
        Timing::token(ds, DsDuration::MotionExitSlow, Easing::MotionEaseAccelerate)
    };
    Some(
        transition(
            format!("{id}-backdrop-in-{key}"),
            (if entering { 1. } else { 0. }, false),
            &timing,
            window,
            cx,
        )
        .apply(
            scrim,
            &timing,
            &Props {
                opacity: Some((0., 1.)),
                ..Default::default()
            },
        )
        .into_any_element(),
    )
}
