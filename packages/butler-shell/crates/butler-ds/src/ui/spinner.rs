//! DS Spinner (Spinner.tsx / Spinner.module.css): the indeterminate traveling-gap ring. Two
//! independent loops run on its circle: `spinner-orbit` grows the dash to most of the ring and
//! lets its tail catch up (`--spinner-duration`, `--spinner-easing` between each pair of
//! keyframes) while the whole arc turns once per `--spinner-rotate-duration` (linear), so the
//! pattern never repeats in lockstep. A turning spinner is a status signal: it is exempt from
//! reduced motion and always keeps running (owner decision).
//!
//! The orbit loop is rasterized once as a flipbook of SVG frames and the GPU picks the frame and
//! adds the turn from the animation clock, so the scene does not change while it spins.
use std::fmt::Write as _;
use std::time::Duration;

use gpui::{
    App, ElementId, FrameSpec, InteractiveElement as _, IntoElement, ParentElement as _,
    RenderOnce, Styled as _, Window, animation_time_ms, canvas, div, px,
};

use super::arc;
use super::context::Ds;
use super::convert;
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

/// Flipbook frames rasterized per second of the orbit loop.
const FRAMES_PER_SECOND: f32 = 60.;

/// One orbit frame as SVG: the shapes `arc::stroke` paints (a polyline through the same
/// 96-per-turn points and a disc at each end), in a `side` by `side` view box. Black, since the
/// sprite is tinted with the text colour.
fn frame_svg(side: f32, stroke: f32, pose: &Pose) -> Vec<u8> {
    let center = side / 2.;
    let radius = RADIUS * side / VIEW;
    let angle = |s: f32| pose.turn + s / 100. * std::f32::consts::TAU;
    let (start, sweep) = (
        angle(pose.from),
        (pose.to - pose.from) / 100. * std::f32::consts::TAU,
    );
    let at = |angle: f32| (center + radius * angle.cos(), center + radius * angle.sin());
    #[expect(
        clippy::cast_possible_truncation,
        clippy::cast_sign_loss,
        reason = "a small non-negative segment count"
    )]
    let steps = ((sweep.abs() / std::f32::consts::TAU * 96.).ceil() as usize).max(1);
    let mut svg = format!(
        "<svg xmlns=\"http://www.w3.org/2000/svg\" width=\"{side}\" height=\"{side}\" viewBox=\"0 0 {side} {side}\">"
    );
    if sweep.abs() > 1e-4 {
        let mut d = String::new();
        for i in 0..=steps {
            let (x, y) = at(start + sweep * i as f32 / steps as f32);
            d.push_str(if i == 0 { "M" } else { "L" });
            _ = write!(d, "{x} {y} ");
        }
        _ = write!(
            svg,
            "<path d=\"{d}\" fill=\"none\" stroke=\"#000\" stroke-width=\"{stroke}\"/>"
        );
    }
    for end in [start, start + sweep] {
        let (x, y) = at(end);
        _ = write!(
            svg,
            "<circle cx=\"{x}\" cy=\"{y}\" r=\"{}\" fill=\"#000\"/>",
            stroke / 2.
        );
    }
    svg.push_str("</svg>");
    svg.into_bytes()
}

impl RenderOnce for Spinner {
    fn render(self, window: &mut Window, cx: &mut App) -> impl IntoElement {
        let ds = Ds::get(cx);
        let (orbit, turn) = (
            ds.duration(DsDuration::SpinnerDuration),
            ds.duration(DsDuration::SpinnerRotateDuration),
        );
        let ease = convert::easing(ds.tokens().ease(Easing::SpinnerEasing));
        let side = self.fit.unwrap_or(self.size);
        let stroke = MIN_STROKE_PX.max(self.size * STROKE_SIZE_RATIO) * side / self.size;
        #[expect(
            clippy::cast_possible_truncation,
            clippy::cast_sign_loss,
            reason = "a small positive frame count"
        )]
        let frame_count = (milliseconds(orbit) / 1000. * FRAMES_PER_SECOND)
            .round()
            .max(1.) as usize;
        // The loop starts at frame 0 when the spinner first renders.
        let start_ms = *window
            .use_keyed_state((self.id.clone(), "start"), cx, |_, _| animation_time_ms())
            .read(cx);
        let spec = FrameSpec {
            frame_count,
            period: orbit,
            start_ms,
            turn: Some(turn),
        };
        div().id(self.id).size(px(side)).flex_none().child(
            canvas(
                |_, _, _| (),
                move |bounds, (), window, cx| {
                    let color = window.text_style().color;
                    window
                        .paint_svg_frames(
                            bounds,
                            format!("butler-ds/spinner/{side}/{stroke}").into(),
                            spec,
                            &|i| {
                                let orbit = i as f32 / frame_count as f32;
                                frame_svg(side, stroke, &pose(orbit, 0., &ease))
                            },
                            Some(color),
                            cx,
                        )
                        .ok();
                },
            )
            .size_full(),
        )
    }
}
