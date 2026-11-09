//! A sheet's motion (BottomSheet.module.css `sheet-slide-in`, `sheet-fade-in`, `sheet-slide-out`,
//! `sheet-fade-out` and the backdrop's), retained on the animation clock.
use gpui::{
    AnyElement, App, Entity, InteractiveElement as _, IntoElement as _, ParentElement as _,
    Styled as _, Window, div, point, px,
};

use super::state::SheetState;
use crate::tokens::{Color, Duration as DsDuration, Easing};
use crate::ui::context::Ds;
use crate::ui::motion::{Props, Timing, keyed};
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
    let (key, entering) = match phase {
        Phase::Closed => return None,
        Phase::Open { key } => (key, true),
        Phase::Exiting { key, .. } => (key, false),
    };
    let state = frame.state.read(cx);
    let ds = Ds::get(cx);
    let reduced = ds.reduced_motion();
    let height = state
        .surface
        .bounds()
        .map_or(frame.window_height, |b| f32::from(b.size.height));
    let from = state.held_offset();
    let (offset, settle) = state.offset(ds);
    let enter_slide = Timing::token(ds, DsDuration::MotionDeliberate, Easing::MotionEaseSettle);
    let exit = Timing::token(ds, DsDuration::MotionExitSlow, Easing::MotionEaseAccelerate);
    let enter_fade = if reduced {
        enter_slide
    } else {
        Timing::token(ds, DsDuration::MotionFast, Easing::MotionEaseStandard)
    };
    let mut moving = div().relative().child(content);
    if entering {
        moving = offset.apply(
            moving,
            &settle,
            &Props {
                offset: Some((point(px(0.), px(0.)), point(px(0.), px(1.)))),
                ..Default::default()
            },
        );
    }
    let layers = [
        (
            "slide",
            enter_slide,
            Props {
                offset: (!reduced).then_some((
                    point(px(0.), px(height)),
                    point(px(0.), px(if entering { 0. } else { from })),
                )),
                ..Default::default()
            },
        ),
        (
            "fade",
            enter_fade,
            Props {
                opacity: Some((0., 1.)),
                ..Default::default()
            },
        ),
    ];
    for (name, incoming, props) in layers {
        let enter_id = format!("{id}-{name}-in-{key}");
        let exit_id = format!("{id}-{name}-out-{key}");
        let enter = keyed(enter_id, 0., 1., &incoming, window, cx);
        let timing = if entering { incoming } else { exit };
        let value = if entering {
            enter
        } else {
            keyed(exit_id, enter.value(&incoming), 0., &timing, window, cx)
        };
        moving = value.apply(div().relative().child(moving), &timing, &props);
    }
    Some(moving.into_any_element())
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
    let enter_timing = Timing::token(ds, DsDuration::MotionBase, Easing::MotionEaseStandard);
    let incoming = keyed(
        format!("{id}-backdrop-in-{key}"),
        0.,
        1.,
        &enter_timing,
        window,
        cx,
    );
    let value = if entering {
        incoming
    } else {
        keyed(
            format!("{id}-backdrop-out-{key}"),
            incoming.value(&enter_timing),
            0.,
            &timing,
            window,
            cx,
        )
    };
    Some(
        value
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
