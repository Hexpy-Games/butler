//! DS SuccessCheck (SuccessCheck.tsx / SuccessCheck.module.css): the completion mark. The whole
//! check pops over `--motion-base` (opacity and `--motion-scale-check`), the ring stroke draws
//! over `--motion-slow` and the check mark follows one `--motion-menu` beat later. Reduced
//! motion keeps only the fade. Strokes are drawn as paths in the inherited text colour.
use gpui::{
    App, Bounds, Div, ElementId, Hsla, IntoElement, LayerMotion, ParentElement as _, PathBuilder,
    Pixels, RenderOnce, Styled as _, Window, animation_time_ms, canvas, div, point, px,
};

use super::context::Ds;
use super::convert;
use super::motion::{Props, Timing, enter, mounted_at};
use crate::tokens::{Duration as DsDuration, Easing, Number};

/// Hugeicons geometry (24 grid, 1.5 stroke).
const PLAIN_MARK: [(f32, f32); 3] = [(5., 14.), (8.5, 17.5), (19., 6.5)]; // DS: SuccessCheck.tsx:4
const RING_MARK: [(f32, f32); 3] = [(8., 12.5), (10.5, 15.), (16., 9.)]; // DS: SuccessCheck.tsx:5
const RING_RADIUS: f32 = 10.; // DS: SuccessCheck.tsx:40
const STROKE: f32 = 1.5; // DS: SuccessCheck.tsx:42
const VIEW: f32 = 24.;

#[derive(IntoElement)]
pub struct SuccessCheck {
    /// Remounting with another key plays the animation again.
    key: ElementId,
    size: f32,
    ring: bool,
    animate: bool,
}

impl SuccessCheck {
    pub fn new(key: impl Into<ElementId>) -> Self {
        Self {
            key: key.into(),
            size: 16.,
            ring: false,
            animate: true,
        }
    }

    /// The pixel box (`ICON_SIZE` values).
    pub fn size(mut self, size: f32) -> Self {
        self.size = size;
        self
    }

    /// Draws the check inside a ring.
    pub fn ring(mut self) -> Self {
        self.ring = true;
        self
    }

    /// `animate={on}`.
    pub fn animate_if(mut self, on: bool) -> Self {
        self.animate = on;
        self
    }

    /// `animate={false}`: the finished check.
    pub fn still(mut self) -> Self {
        self.animate = false;
        self
    }
}

/// How far each part of the check has come, 0 to 1.
#[derive(Clone, Copy)]
struct Progress {
    ring: f32,
    mark: f32,
}

/// A polyline cut at `fraction` of its length.
fn partial(points: &[(f32, f32)], fraction: f32) -> Vec<(f32, f32)> {
    let length = |a: (f32, f32), b: (f32, f32)| (b.0 - a.0).hypot(b.1 - a.1);
    let total: f32 = points.windows(2).map(|w| length(w[0], w[1])).sum();
    let mut left = total * fraction.clamp(0., 1.);
    let mut out = vec![points[0]];
    for w in points.windows(2) {
        let span = length(w[0], w[1]);
        if left >= span {
            out.push(w[1]);
            left -= span;
        } else {
            let k = if span > 0. { left / span } else { 0. };
            out.push((
                w[0].0 + (w[1].0 - w[0].0) * k,
                w[0].1 + (w[1].1 - w[0].1) * k,
            ));
            break;
        }
    }
    out
}

/// The ring from twelve o'clock, clockwise, as far as `fraction` of the circumference.
fn arc(fraction: f32) -> Vec<(f32, f32)> {
    let steps = 64;
    #[expect(
        clippy::cast_possible_truncation,
        clippy::cast_sign_loss,
        reason = "a small non-negative segment count"
    )]
    let count = (steps as f32 * fraction.clamp(0., 1.)).ceil() as usize;
    (0..=count)
        .map(|i| {
            let angle = (i as f32 / steps as f32).min(fraction) * std::f32::consts::TAU
                - std::f32::consts::FRAC_PI_2;
            (
                12. + RING_RADIUS * angle.cos(),
                12. + RING_RADIUS * angle.sin(),
            )
        })
        .collect()
}

struct Painter {
    origin: gpui::Point<Pixels>,
    unit: f32,
    color: Hsla,
}

impl Painter {
    fn at(&self, (x, y): (f32, f32)) -> gpui::Point<Pixels> {
        let map = |v: f32| v * self.unit;
        point(self.origin.x + px(map(x)), self.origin.y + px(map(y)))
    }

    /// A round-capped, round-joined stroke along `points`.
    fn stroke(&self, points: &[(f32, f32)], window: &mut Window) {
        let width = STROKE * self.unit;
        if points.len() >= 2 {
            let mut path = PathBuilder::stroke(px(width));
            path.move_to(self.at(points[0]));
            for p in &points[1..] {
                path.line_to(self.at(*p));
            }
            if let Ok(path) = path.build() {
                window.paint_path(path, self.color);
            }
        }
        // Round caps and joins: a disc of the stroke width on every vertex.
        for p in points {
            self.dot(*p, width / 2., window);
        }
    }

    fn dot(&self, center: (f32, f32), radius: f32, window: &mut Window) {
        let c = self.at(center);
        let mut path = PathBuilder::fill();
        let steps = 16;
        for i in 0..steps {
            let a = i as f32 / steps as f32 * std::f32::consts::TAU;
            let p = point(c.x + px(radius * a.cos()), c.y + px(radius * a.sin()));
            if i == 0 {
                path.move_to(p);
            } else {
                path.line_to(p);
            }
        }
        path.close();
        if let Ok(path) = path.build() {
            window.paint_path(path, self.color);
        }
    }
}

fn draw(bounds: Bounds<Pixels>, window: &mut Window, ring: bool, progress: Progress) {
    let color = window.text_style().color;
    let painter = Painter {
        origin: bounds.origin,
        unit: f32::from(bounds.size.width) / VIEW,
        color,
    };
    if ring && progress.ring > 0. {
        painter.stroke(&arc(progress.ring), window);
    }
    let mark = if ring { &RING_MARK } else { &PLAIN_MARK };
    if progress.mark > 0. {
        painter.stroke(&partial(mark, progress.mark), window);
    }
}

fn check(size: f32, ring: bool, progress: Progress) -> Div {
    div().size(px(size)).flex_none().child(
        canvas(
            |_, _, _| (),
            move |bounds, (), window, _| draw(bounds, window, ring, progress),
        )
        .size_full(),
    )
}

impl RenderOnce for SuccessCheck {
    fn render(self, window: &mut Window, cx: &mut App) -> impl IntoElement {
        let ds = Ds::get(cx);
        let done = Progress { ring: 1., mark: 1. };
        if !self.animate {
            return check(self.size, self.ring, done).into_any_element();
        }
        let (base, slow, menu) = (
            ds.duration(DsDuration::MotionBase).as_secs_f32(),
            ds.duration(DsDuration::MotionSlow).as_secs_f32(),
            ds.duration(DsDuration::MotionMenu).as_secs_f32(),
        );
        let total = base.max(menu + slow);
        let timing = Timing::linear(std::time::Duration::from_secs_f32(total));
        let pop = Timing::token(ds, DsDuration::MotionBase, Easing::MotionEaseStandard);
        let ease = convert::easing(ds.tokens().ease(Easing::MotionEaseStandard));
        let props = Props {
            opacity: Some((0., 1.)),
            scale: Some((ds.number(Number::MotionScaleCheck), 1.)),
            ..Default::default()
        };
        let draws = !ds.reduced_motion();
        let start_ms = mounted_at(self.key.clone(), window, cx);
        let el = if !draws || animation_time_ms().wrapping_sub(start_ms) >= timing.ms() {
            check(self.size, self.ring, done)
        } else {
            let n = (timing.ms() * 60).div_ceil(1000);
            div()
                .relative()
                .size(px(self.size))
                .flex_none()
                .children((0..n).map(|i| {
                    let elapsed = (i + 1) as f32 / n as f32 * total;
                    let step = |start: f32, length: f32| {
                        if length <= 0. {
                            1.
                        } else {
                            ease(((elapsed - start) / length).clamp(0., 1.))
                        }
                    };
                    let progress = Progress {
                        ring: step(0., slow),
                        mark: step(menu, slow),
                    };
                    div()
                        .absolute()
                        .size_full()
                        .motion(LayerMotion {
                            visible: (i as f32 / n as f32, (i + 1) as f32 / n as f32),
                            ..timing.motion(start_ms)
                        })
                        .child(check(self.size, self.ring, progress))
                }))
        };
        enter(self.key, &pop, &props, el, window, cx).into_any_element()
    }
}
