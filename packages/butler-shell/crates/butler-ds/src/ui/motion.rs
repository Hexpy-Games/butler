//! Time-driven DS motion on retained painted groups. Tokens zero travel and scale under
//! reduced motion, leaving opacity fades. Decorative loops follow [`Loop`].
use std::time::Duration;

use gpui::{
    App, AppContext as _, ElementId, LayerMotion, MotionEasing, MotionRepeat, Pixels, Point,
    Styled, Window, animation_time_ms, point,
};

use super::context::Ds;
use super::convert;
use crate::tokens::{Duration as DsDuration, Ease, Easing};

/// A repeating animation, and whether reduced motion stops it.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Loop {
    /// Decorative loops (pulses, shimmers) stop under reduced motion.
    Decorative,
    /// The spinner keeps rotating under reduced motion (owner decision).
    Spinner,
}

impl Loop {
    pub fn runs(self, ds: &Ds) -> bool {
        self == Self::Spinner || !ds.reduced_motion()
    }
}

/// One timed animation: its duration and token easing curve.
#[derive(Clone, Copy)]
pub struct Timing {
    pub duration: Duration,
    pub(super) ease: Ease,
}

impl Timing {
    pub fn token(ds: &Ds, duration: DsDuration, ease: Easing) -> Self {
        Self {
            duration: ds.duration(duration),
            ease: ds.tokens().ease(ease),
        }
    }

    pub fn linear(duration: Duration) -> Self {
        Self {
            duration,
            ease: Ease::Linear(&[(0., 0.), (1., 1.)]),
        }
    }

    /// The eased CPU value at linear progress `x` (0 to 1).
    pub fn ease(&self, x: f32) -> f32 {
        convert::ease_at(self.ease, x)
    }

    pub fn ms(&self) -> u32 {
        #[expect(
            clippy::cast_possible_truncation,
            reason = "DS durations fit the animation clock"
        )]
        {
            self.duration.as_millis() as u32
        }
    }

    pub fn easing(&self) -> MotionEasing {
        match self.ease {
            Ease::Bezier(b) => MotionEasing::CubicBezier(b),
            Ease::Linear(stops) => {
                let points: Vec<_> = stops.iter().map(|&(value, at)| (at, value)).collect();
                MotionEasing::linear(&points)
            }
        }
    }

    pub fn motion(&self, start_ms: u32) -> LayerMotion {
        LayerMotion {
            start_ms,
            duration_ms: self.ms(),
            easing: self.easing(),
            ..LayerMotion::NONE
        }
    }
}

/// Property endpoints at scalar zero and one.
#[derive(Default)]
pub struct Props {
    pub opacity: Option<(f32, f32)>,
    pub offset: Option<(Point<Pixels>, Point<Pixels>)>,
    pub relative_offset: Option<(Point<f32>, Point<f32>)>,
    pub scale: Option<(f32, f32)>,
    pub rotation: Option<(f32, f32)>,
    pub origin: Option<(f32, f32)>,
}

/// A scalar heading toward a target on gpui's wrapping animation clock.
#[derive(Clone, Copy, Debug)]
pub struct Transition {
    pub(super) from: f32,
    pub(super) to: f32,
    pub(super) start_ms: u32,
}

/// Retargets from the current value, without requesting host frames.
pub fn transition(
    id: impl Into<ElementId>,
    (target, jump): (f32, bool),
    timing: &Timing,
    window: &mut Window,
    cx: &mut App,
) -> Transition {
    let now = animation_time_ms();
    let state = window.use_keyed_state(id, cx, |_, _| {
        (
            Transition {
                from: target,
                to: target,
                start_ms: now.wrapping_sub(timing.ms()),
            },
            *timing,
        )
    });
    state.update(cx, |(value, previous), _| {
        if jump {
            *value = Transition {
                from: target,
                to: target,
                start_ms: now.wrapping_sub(timing.ms()),
            };
        } else if target != value.to {
            *value = Transition {
                from: value.value(previous),
                to: target,
                start_ms: now,
            };
        }
        *previous = *timing;
        *value
    })
}

/// A phase animation, starting at the first render of `id`.
pub fn keyed(
    id: impl Into<ElementId>,
    from: f32,
    to: f32,
    _timing: &Timing,
    window: &mut Window,
    cx: &mut App,
) -> Transition {
    let id = id.into();
    let start_ms = mounted_at(id.clone(), window, cx);
    let endpoints = window.use_keyed_state((id, "endpoints"), cx, |_, _| (from, to));
    let (from, to) = *endpoints.read(cx);
    Transition { from, to, start_ms }
}

impl Transition {
    pub fn motion(&self, timing: &Timing) -> LayerMotion {
        timing.motion(self.start_ms)
    }

    pub fn target(&self) -> f32 {
        self.to
    }

    pub fn value(&self, timing: &Timing) -> f32 {
        if !self.moving(timing) {
            return self.to;
        }
        let elapsed = self.elapsed().unwrap_or(0);
        self.from + (self.to - self.from) * timing.ease(elapsed as f32 / timing.ms() as f32)
    }

    /// Running, or waiting for a start in the future (which holds `from`).
    pub fn moving(&self, timing: &Timing) -> bool {
        self.elapsed().is_none_or(|elapsed| elapsed < timing.ms())
    }

    /// Milliseconds since the start; `None` before a future start.
    fn elapsed(&self) -> Option<u32> {
        let elapsed = animation_time_ms().wrapping_sub(self.start_ms);
        (elapsed < 1 << 31).then_some(elapsed)
    }

    pub fn apply<E: Styled>(&self, mut el: E, timing: &Timing, props: &Props) -> E {
        if self.moving(timing) {
            let mut motion = self.motion(timing);
            if let Some((a, b)) = props.opacity {
                motion.opacity = (a + (b - a) * self.from, a + (b - a) * self.to);
            }
            if let Some((a, b)) = props.offset {
                motion.offset = (a + (b - a) * self.from, a + (b - a) * self.to);
            }
            if let Some((a, b)) = props.relative_offset {
                motion.relative_offset = (a + (b - a) * self.from, a + (b - a) * self.to);
            }
            if let Some((a, b)) = props.scale {
                motion.scale = (a + (b - a) * self.from, a + (b - a) * self.to);
            }
            if let Some((a, b)) = props.rotation {
                motion.rotation = (a + (b - a) * self.from, a + (b - a) * self.to);
            }
            if let Some((x, y)) = props.origin {
                motion.origin = point(x, y);
            }
            return el.motion(motion);
        }
        if let Some((a, b)) = props.opacity {
            el = el.opacity(a + (b - a) * self.to);
        }
        if let Some((a, b)) = props.scale {
            el = el.scale(a + (b - a) * self.to);
        }
        if let Some((x, y)) = props.origin {
            el = el.transform_origin(x, y);
        }
        // A resting offset or turn has no layout-neutral style: hold it as a motion that has
        // already finished (it keeps the element's own positioning and asks for no frames).
        let at = |(a, b): (Point<Pixels>, Point<Pixels>)| a + (b - a) * self.to;
        let offset = props.offset.map(at).unwrap_or_default();
        let relative_offset = props
            .relative_offset
            .map(|(a, b)| a + (b - a) * self.to)
            .unwrap_or_default();
        let rotation = props.rotation.map_or(0., |(a, b)| a + (b - a) * self.to);
        if offset != Point::default() || relative_offset != Point::default() || rotation != 0. {
            let mut held = timing.motion(animation_time_ms().wrapping_sub(timing.ms().max(1)));
            held.duration_ms = held.duration_ms.max(1);
            held.offset = (offset, offset);
            held.relative_offset = (relative_offset, relative_offset);
            held.rotation = (rotation, rotation);
            if let Some((x, y)) = props.origin {
                held.origin = point(x, y);
            }
            el = el.motion(held);
        }
        el
    }
}

/// The clock value of an id's first render.
pub fn mounted_at(id: impl Into<ElementId>, window: &mut Window, cx: &mut App) -> u32 {
    *window
        .use_keyed_state(id, cx, |_, _| animation_time_ms())
        .read(cx)
}

/// A mount animation, from scalar zero to one.
pub fn enter<E: Styled>(
    id: impl Into<ElementId>,
    timing: &Timing,
    props: &Props,
    el: E,
    window: &mut Window,
    cx: &mut App,
) -> E {
    keyed(id, 0., 1., timing, window, cx).apply(el, timing, props)
}

/// A repeating zero-to-one motion; alternate reverses every other iteration.
pub fn looping<E: Styled>(
    el: E,
    timing: &Timing,
    start_ms: u32,
    alternate: bool,
    props: &Props,
) -> E {
    el.motion(LayerMotion {
        repeat: if alternate {
            MotionRepeat::Alternate
        } else {
            MotionRepeat::Loop
        },
        opacity: props.opacity.unwrap_or(LayerMotion::NONE.opacity),
        offset: props.offset.unwrap_or(LayerMotion::NONE.offset),
        relative_offset: props
            .relative_offset
            .unwrap_or(LayerMotion::NONE.relative_offset),
        scale: props.scale.unwrap_or(LayerMotion::NONE.scale),
        rotation: props.rotation.unwrap_or(LayerMotion::NONE.rotation),
        origin: props
            .origin
            .map_or(LayerMotion::NONE.origin, |(x, y)| point(x, y)),
        ..timing.motion(start_ms)
    })
}

/// Requests one layout frame after a measured size or position changes. Stop once it settles.
pub fn remeasure(window: &mut Window) {
    window.request_animation_frame();
}

/// Requests a frame while ongoing input drives a wheel glide or drag edge auto-scroll.
pub fn input_frame(window: &mut Window) {
    window.request_animation_frame();
}

/// Requests a fallback frame only when `paint_live` reports that a live layer is covered.
pub fn live_fallback_frame(window: &mut Window) {
    window.request_animation_frame();
}

/// For delays, debounces and data polls. Never animate with it; motion goes through
/// `LayerMotion`. A poll notifies only when the fetched value changed.
pub async fn sleep(executor: &gpui::BackgroundExecutor, duration: Duration) {
    executor.timer(duration).await;
}

/// Runs a one-shot callback after `after`; use for delayed intent, dismissal or completion.
pub fn delay(
    window: &mut Window,
    cx: &mut App,
    after: Duration,
    f: impl FnOnce(&mut Window, &mut App) + 'static,
) {
    window
        .spawn(cx, async move |cx| {
            cx.background_executor().timer(after).await;
            cx.update(f).ok();
        })
        .detach();
}

/// Wakes only the calling view after `after`, for example to unmount a completed exit.
pub fn wake_after(window: &mut Window, cx: &mut App, after: Duration) {
    wake_task(window, cx, after).detach();
}

/// [`wake_after`] that the caller holds: dropping the task cancels the wake, so a re-armed
/// deadline replaces the earlier one.
pub fn wake_task(window: &mut Window, cx: &mut App, after: Duration) -> gpui::Task<()> {
    let view = window.current_view();
    window.spawn(cx, async move |cx| {
        cx.background_executor().timer(after).await;
        cx.update(|_, cx| cx.notify(view)).ok();
    })
}
