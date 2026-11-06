//! DS Spinner (Spinner.tsx / Spinner.module.css): the indeterminate traveling-gap ring. Two
//! independent loops run on its circle: `spinner-orbit` grows the dash to most of the ring and
//! lets its tail catch up (`--spinner-duration`, `--spinner-easing` between each pair of
//! keyframes) while the whole arc turns once per `--spinner-rotate-duration` (linear), so the
//! pattern never repeats in lockstep. A turning spinner is a status signal: it is exempt from
//! reduced motion and always keeps running (owner decision).
use std::time::Duration;

use gpui::{
    App, ElementId, IntoElement, ParentElement as _, RenderOnce, Styled as _, Window, canvas, div,
    point, px,
};

use super::arc;
use super::context::Ds;
use super::convert;
use super::motion::{Timing, Tween};
use crate::tokens::{Duration as DsDuration, Easing};

/// `r` of the circle in the 100-unit view box, and the stroke rule `max(1.35px, size * 0.071)`.
const RADIUS: f32 = 36.5; // DS: Spinner.tsx:41
const MIN_STROKE_PX: f32 = 1.35; // DS: Spinner.tsx:6
const STROKE_SIZE_RATIO: f32 = 0.071; // DS: Spinner.tsx:7
const VIEW: f32 = 100.; // DS: Spinner.tsx:8

#[derive(IntoElement)]
pub struct Spinner {
    id: ElementId,
    size: f32,
    fit: Option<f32>,
}

impl Spinner {
    /// `id` keys the animation clock: it starts when the spinner first renders.
    pub fn new(id: impl Into<ElementId>) -> Self {
        Self {
            id: id.into(),
            size: 16.,
            fit: None,
        }
    }

    /// The pixel size the ring and its stroke are designed at (`size`).
    pub fn size(mut self, size: f32) -> Self {
        self.size = size;
        self
    }

    /// Draws the whole ring scaled to a box of this many pixels (an `svg` filling a larger
    /// square, as the sidebar ProgressRing does).
    pub fn fit(mut self, side: f32) -> Self {
        self.fit = Some(side);
        self
    }
}

/// The two loops at one instant.
struct Pose {
    /// Dash start and end along the path, 0 to 100.
    from: f32,
    to: f32,
    /// Rotation of the whole ring, radians.
    turn: f32,
}

/// The orbit keyframes (0%: `1 150` at 0, 50%: `70 150` at -18, 100%: `70 150` at -99) with the
/// easing between each pair, and the rotation.
fn pose(orbit: f32, turn: f32, ease: &impl Fn(f32) -> f32) -> Pose {
    let (length, offset) = if orbit < 0.5 {
        let u = ease(orbit / 0.5);
        (1. + (70. - 1.) * u, -18. * u)
    } else {
        let u = ease((orbit - 0.5) / 0.5);
        (70., -18. + (-99. + 18.) * u)
    };
    let from = (-offset).clamp(0., 100.);
    Pose {
        from,
        to: (from + length).min(100.),
        turn: arc::TOP + turn * std::f32::consts::TAU,
    }
}

fn milliseconds(duration: Duration) -> f32 {
    duration.as_secs_f32() * 1000.
}

impl RenderOnce for Spinner {
    fn render(self, _: &mut Window, cx: &mut App) -> impl IntoElement {
        let ds = Ds::get(cx);
        let (orbit_ms, turn_ms) = (
            milliseconds(ds.duration(DsDuration::SpinnerDuration)),
            milliseconds(ds.duration(DsDuration::SpinnerRotateDuration)),
        );
        let ease = convert::easing(ds.tokens().ease(Easing::SpinnerEasing));
        // Both periods fit a whole number of times into their least common multiple.
        let cycle = lcm_ms(orbit_ms, turn_ms);
        let side = self.fit.unwrap_or(self.size);
        let stroke = MIN_STROKE_PX.max(self.size * STROKE_SIZE_RATIO) * side / self.size;
        Tween::new(
            self.id,
            div(),
            Timing::linear(Duration::from_secs_f32(cycle / 1000.)),
            move |el, t| {
                let elapsed = t * cycle;
                let pose = pose(
                    (elapsed % orbit_ms) / orbit_ms,
                    (elapsed % turn_ms) / turn_ms,
                    &ease,
                );
                el.size(px(side)).flex_none().child(
                    canvas(
                        |_, _, _| (),
                        move |bounds, (), window, _| {
                            let color = window.text_style().color;
                            let unit = f32::from(bounds.size.width) / VIEW;
                            let center = point(
                                bounds.origin.x + bounds.size.width / 2.,
                                bounds.origin.y + bounds.size.height / 2.,
                            );
                            let angle = |s: f32| pose.turn + s / 100. * std::f32::consts::TAU;
                            arc::stroke(
                                window,
                                center,
                                RADIUS * unit,
                                stroke,
                                (
                                    angle(pose.from),
                                    (pose.to - pose.from) / 100. * std::f32::consts::TAU,
                                ),
                                color,
                            );
                        },
                    )
                    .size_full(),
                )
            },
        )
        .repeat()
    }
}

/// The least common multiple of two periods in whole milliseconds.
fn lcm_ms(first: f32, second: f32) -> f32 {
    #[expect(
        clippy::cast_possible_truncation,
        clippy::cast_sign_loss,
        reason = "durations are small whole millisecond counts"
    )]
    let (long, short) = (first.round().max(1.) as u64, second.round().max(1.) as u64);
    let (mut gcd, mut rest) = (long, short);
    while rest != 0 {
        (gcd, rest) = (rest, gcd % rest);
    }
    #[expect(clippy::cast_precision_loss, reason = "a small millisecond count")]
    let cycle = (long / gcd * short) as f32;
    cycle
}
