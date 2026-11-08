//! Time-driven DS motion on retained painted groups. Tokens zero travel and scale under
//! reduced motion, leaving opacity fades. Decorative loops follow [`Loop`].
use std::time::{Duration, Instant};

use gpui::{
    App, ElementId, LayerMotion, MotionEasing, MotionRepeat, Pixels, Point, Styled, Window,
    animation_time_ms, point, relative,
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
    ease: Ease,
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
    pub origin: Option<(f32, f32)>,
}

/// A scalar heading toward a target on gpui's wrapping animation clock.
#[derive(Clone, Copy)]
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
                from: 0.,
                to: target,
                start_ms: now,
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

impl Transition {
    pub fn target(&self) -> f32 {
        self.to
    }

    pub fn value(&self, timing: &Timing) -> f32 {
        if !self.moving(timing) {
            return self.to;
        }
        let elapsed = animation_time_ms().wrapping_sub(self.start_ms);
        self.from + (self.to - self.from) * timing.ease(elapsed as f32 / timing.ms() as f32)
    }

    pub fn moving(&self, timing: &Timing) -> bool {
        animation_time_ms().wrapping_sub(self.start_ms) < timing.ms()
    }

    pub fn apply<E: Styled>(&self, mut el: E, timing: &Timing, props: &Props) -> E {
        if self.moving(timing) {
            let mut motion = timing.motion(self.start_ms);
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
        if let Some((a, b)) = props.offset {
            let p = a + (b - a) * self.to;
            el = el.relative().left(p.x).top(p.y);
        }
        if let Some((a, b)) = props.relative_offset {
            let p = a + (b - a) * self.to;
            el = el.relative().left(relative(p.x)).top(relative(p.y));
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
    Transition {
        from: 0.,
        to: 1.,
        start_ms: mounted_at(id, window, cx),
    }
    .apply(el, timing, props)
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
        origin: props
            .origin
            .map_or(LayerMotion::NONE.origin, |(x, y)| point(x, y)),
        ..timing.motion(start_ms)
    })
}

/// A value that eases toward a target over a duration (a CSS transition of one property).
/// A new target restarts from wherever the value is now.
#[derive(Clone, Copy, Debug, Default)]
pub struct Ramp {
    value: f32,
    from: f32,
    to: f32,
    since: Option<Instant>,
}

impl Ramp {
    /// At rest on `value`.
    pub fn at(value: f32) -> Self {
        Self {
            value,
            from: value,
            to: value,
            since: None,
        }
    }

    pub fn target(&self) -> f32 {
        self.to
    }

    /// Where the value is now (as of the last [`Self::sample`]).
    pub fn value(&self) -> f32 {
        self.value
    }

    /// Heads for `to`; `jump` lands there at once (no transition).
    pub fn retarget(&mut self, to: f32, now: Instant, jump: bool) {
        if (to - self.to).abs() < f32::EPSILON && !jump {
            return;
        }
        self.from = if jump { to } else { self.value };
        self.to = to;
        self.since = (!jump).then_some(now);
        if jump {
            self.value = to;
        }
    }

    /// The value at `now`, and whether it is still moving.
    pub fn sample(
        &mut self,
        now: Instant,
        duration: Duration,
        ease: &dyn Fn(f32) -> f32,
    ) -> (f32, bool) {
        let Some(since) = self.since else {
            return (self.to, false);
        };
        let total = duration.as_secs_f32();
        let elapsed = now.saturating_duration_since(since).as_secs_f32();
        if total <= 0. || elapsed >= total {
            *self = Self::at(self.to);
            return (self.to, false);
        }
        self.value = self.from + (self.to - self.from) * ease(elapsed / total);
        (self.value, true)
    }
}
