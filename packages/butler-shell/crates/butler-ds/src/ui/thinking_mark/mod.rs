//! DS ButlerThinkingMark (ButlerThinkingMark.tsx and thinking-mark/*): Butler's identity mark and
//! its thinking animation (the riso halftone design) in an [`AspectFrame`]. `Idle` draws the
//! exact filled logo (fused bowtie and ring); `Working` morphs the bowtie into a lit halftone
//! moon in one continuous transformation (the outline, the dot field, the riso blue and pink
//! and the orbiting light all read one spring), and back to `Idle` is the same morph in
//! reverse. Reduced motion stops the morph, draws the still logo and, while working, breathes
//! it in opacity on the pulse cadence. The frame clock runs only while the mark moves.
//!
//! Not reproduced: the paper grain of marks 64px and larger (thinking-mark/mark-surface.ts
//! `buildGrain`), the clip of the early morph to the outline (dots whose centre lies outside it
//! are dropped instead of trimmed), pausing offscreen or in a hidden window, and forgetting a
//! `morph_key` once no mark holds it.
mod geometry;
mod halftone;
mod morph;

use std::cell::RefCell;
use std::collections::HashMap;
use std::rc::Rc;
use std::time::Instant;

use gpui::{
    App, Bounds, Corners, ElementId, Hsla, IntoElement, ParentElement as _, Pixels, RenderOnce,
    SharedString, Styled as _, Window, canvas, div, point, px, size,
};

use self::geometry::{CENTER, DESIGN, RING_R, RING_W, morph_sd, rest_outline};
use self::halftone::{Frame, lattice, mis_of, pitch_of, size_class};
use self::morph::MorphSim;
use super::aspect_frame::AspectFrame;
use super::context::Ds;
use super::convert;
use super::icon::IconSize;
use crate::tokens::{Color, Duration as DsDuration, Easing};

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub enum MarkState {
    #[default]
    Idle,
    Working,
}

/// The ink set: `Dark` is white ink, `Light` near-black.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum MarkTheme {
    Dark,
    Light,
}

/// An opaque colour from `0xRRGGBB`.
fn hex(rgb: u32) -> Hsla {
    let channel = |shift: u32| ((rgb >> shift) & 0xff) as f32 / 255.;
    convert::hsla(crate::tokens::Rgba {
        r: channel(16),
        g: channel(8),
        b: channel(0),
        a: 1.,
    })
}

/// The first-run key ink of each theme. // DS: butlerMarkTheme.ts:7
fn key_ink(theme: MarkTheme) -> Hsla {
    match theme {
        MarkTheme::Dark => hex(0xff_ff_ff),
        MarkTheme::Light => hex(0x0a_0a_0b),
    }
}

/// The riso blue and pink with the alpha each prints at (`RISO_INKS`, butlerMarkTheme.ts:26-36).
fn riso(theme: MarkTheme, ds: &Ds, scope: MarkTheme) -> (Hsla, Hsla) {
    let (blue_alpha, pink_alpha) = match theme {
        MarkTheme::Dark => (0.85, 0.8),
        MarkTheme::Light => (0.8, 0.75),
    };
    if theme == scope {
        // The `--butler-ink-*` tokens of the scope the mark is in, each at its own alpha.
        let tone = |token, alpha| Hsla {
            alpha,
            ..ds.color(token)
        };
        return (
            tone(Color::ButlerInkBlue, blue_alpha),
            tone(Color::ButlerInkPink, pink_alpha),
        );
    }
    let (blue, pink) = match theme {
        MarkTheme::Dark => (0x60_8c_ff, 0xff_70_be),
        MarkTheme::Light => (0x00_78_bf, 0xff_48_b0),
    };
    let tone = |rgb: u32, alpha| Hsla { alpha, ..hex(rgb) };
    (tone(blue, blue_alpha), tone(pink, pink_alpha))
}

/// Marks that stand for the same ongoing work share a simulation by key.
#[derive(Default)]
struct SharedSims(RefCell<HashMap<SharedString, Rc<RefCell<MorphSim>>>>);

impl gpui::Global for SharedSims {}

/// The reduced-motion breathe, and the settle back to full opacity when it ends.
#[derive(Default)]
struct Breathe {
    since: Option<Instant>,
    settle: Option<(Instant, f32)>,
    last: f32,
}

/// The easings and durations of the breathe.
struct Cadence {
    /// One way of the breathe: twice the pulse duration.
    pulse: std::time::Duration,
    slow: std::time::Duration,
    spinner: crate::tokens::Ease,
    standard: crate::tokens::Ease,
}

impl Breathe {
    /// The canvas opacity now, and whether it is still moving: while `breathing` it alternates
    /// between 1 and 0.45 on the Spinner easing; leaving it settles from where it is back to 1.
    fn opacity(&mut self, now: Instant, breathing: bool, cadence: &Cadence) -> (f32, bool) {
        if breathing {
            let since = *self.since.get_or_insert(now);
            self.settle = None;
            let phase = (now.saturating_duration_since(since).as_secs_f32()
                / cadence.pulse.as_secs_f32())
            .rem_euclid(2.);
            let q = if phase < 1. { phase } else { 2. - phase };
            self.last = 1. - 0.55 * convert::ease_at(cadence.spinner, q); // DS: ButlerThinkingMark.module.css:6
            return (self.last, true);
        }
        if self.since.take().is_some() {
            self.settle = Some((now, self.last));
        }
        let Some((start, from)) = self.settle else {
            return (1., false);
        };
        let u = now.saturating_duration_since(start).as_secs_f32() / cadence.slow.as_secs_f32();
        if u >= 1. {
            self.settle = None;
            self.last = 1.;
            return (1., false);
        }
        self.last = from + (1. - from) * convert::ease_at(cadence.standard, u);
        (self.last, true)
    }
}

/// One ink printed as a layer at its own alpha: the rest logo while idle, else the screen.
fn layer(ink: usize, look: Painting, alpha: f32) -> gpui::Div {
    let drawing = canvas(
        |bounds, _, _| bounds,
        move |bounds, _: Bounds<Pixels>, window, _| {
            let (area, _) = square(bounds);
            if look.idle && ink == 0 {
                let k = f32::from(area.size.width) / DESIGN;
                paint_rest(window, area, k, look.key);
                paint_ring(window, area, k, look.key);
            } else if !look.idle {
                paint_screen(window, area, &look, ink);
            }
        },
    )
    .absolute()
    .size_full();
    div().absolute().size_full().opacity(alpha).child(drawing)
}

#[derive(IntoElement)]
pub struct ButlerThinkingMark {
    id: ElementId,
    state: MarkState,
    size: Option<IconSize>,
    theme: Option<MarkTheme>,
    reduced_motion: Option<bool>,
    morph_key: Option<SharedString>,
}

impl ButlerThinkingMark {
    pub fn new(id: impl Into<ElementId>) -> Self {
        Self {
            id: id.into(),
            state: MarkState::Idle,
            size: None,
            theme: None,
            reduced_motion: None,
            morph_key: None,
        }
    }

    /// `Idle` draws the filled logo; `Working` runs the riso halftone animation. Flip it on one
    /// mounted mark.
    pub fn state(mut self, state: MarkState) -> Self {
        self.state = state;
        self
    }

    /// Fixed square size from `--icon-size-*`; omitted, the mark fills the container width.
    pub fn size(mut self, size: IconSize) -> Self {
        self.size = Some(size);
        self
    }

    /// Ink set for the surface; omitted, the app's theme.
    pub fn theme(mut self, theme: MarkTheme) -> Self {
        self.theme = Some(theme);
        self
    }

    /// Forces reduced motion on or off; defaults to the OS setting and the app setting.
    pub fn reduced_motion(mut self, reduced: bool) -> Self {
        self.reduced_motion = Some(reduced);
        self
    }

    /// Marks with the same key share one morph: a remount mid-work continues instead of
    /// restarting from the logo.
    pub fn morph_key(mut self, key: impl Into<SharedString>) -> Self {
        self.morph_key = Some(key.into());
        self
    }

    fn simulation(&self, window: &mut Window, cx: &mut App) -> Rc<RefCell<MorphSim>> {
        if let Some(key) = &self.morph_key {
            let sims = cx.default_global::<SharedSims>();
            return sims.0.borrow_mut().entry(key.clone()).or_default().clone();
        }
        window
            .use_keyed_state((self.id.clone(), "sim"), cx, |_, _| {
                Rc::new(RefCell::new(MorphSim::default()))
            })
            .read(cx)
            .clone()
    }
}

/// What a frame paints.
#[derive(Clone)]
struct Painting {
    m: f32,
    t: f32,
    idle: bool,
    key: Hsla,
    blue: Hsla,
    pink: Hsla,
}

/// The square the mark is drawn in, and the scale from design units.
fn square(bounds: Bounds<Pixels>) -> (Bounds<Pixels>, f32) {
    let side = bounds.size.width.min(bounds.size.height);
    let origin = point(
        bounds.origin.x + (bounds.size.width - side) / 2.,
        bounds.origin.y + (bounds.size.height - side) / 2.,
    );
    (
        Bounds::new(origin, size(side, side)),
        f32::from(side) / DESIGN,
    )
}

fn polygon(window: &mut Window, points: impl Iterator<Item = gpui::Point<Pixels>>, color: Hsla) {
    let mut path = gpui::PathBuilder::fill();
    for (n, p) in points.enumerate() {
        if n == 0 {
            path.move_to(p);
        } else {
            path.line_to(p);
        }
    }
    path.close();
    if let Ok(path) = path.build() {
        window.paint_path(path, color);
    }
}

/// The exact logo: the traced ribbon and the ring.
fn paint_rest(window: &mut Window, area: Bounds<Pixels>, k: f32, color: Hsla) {
    let rays = rest_outline();
    let centre = area.center();
    polygon(
        window,
        rays.iter().enumerate().map(|(n, r)| {
            let angle = n as f32 / rays.len() as f32 * std::f32::consts::TAU;
            point(
                centre.x + px(angle.cos() * r * k),
                centre.y + px(angle.sin() * r * k),
            )
        }),
        color,
    );
}

fn paint_ring(window: &mut Window, area: Bounds<Pixels>, k: f32, color: Hsla) {
    super::arc::ring(window, area.center(), RING_R * k, RING_W * k, color);
}

/// One screen of dots (`ink` 0 key, 1 blue, 2 pink), `(dx, dy)` design units off register.
fn paint_dots(
    window: &mut Window,
    area: Bounds<Pixels>,
    k: f32,
    frame: &Frame,
    ink: usize,
    offset: (f32, f32),
    color: Hsla,
) {
    let class = size_class(f32::from(area.size.width));
    let layer = &lattice(class)[ink];
    // The clip to the outline of the early morph: dots whose centre is outside it are dropped.
    let margin = (frame.m < CLIP_RELEASE).then(|| 3. * pitch_of(class) * frame.m);
    let origin = area.origin;
    for cell in &layer.cells {
        let r = frame.dot_radius(layer, cell, ink);
        if r <= 0. {
            continue;
        }
        if let Some(margin) = margin {
            let dc = (cell.x - CENTER).hypot(cell.y - CENTER);
            if morph_sd(geometry::sd_ribbon(cell.x, cell.y), dc, frame.m, frame.br) > margin {
                continue;
            }
        }
        let (x, y) = (cell.x + offset.0, cell.y + offset.1);
        let bounds = Bounds::new(
            point(origin.x + px((x - r) * k), origin.y + px((y - r) * k)),
            size(px(2. * r * k), px(2. * r * k)),
        );
        window.paint_quad(
            gpui::PaintQuad::new(bounds)
                .background(color)
                .corner_radii(Corners::all(px(r * k))),
        );
    }
}

/// Progress past which the clip trims nothing. // DS: morph-outline.ts:56
const CLIP_RELEASE: f32 = 0.6;

/// The halftone moon: the riso screens off register, the key screen on top, then the ring.
fn paint_screen(window: &mut Window, area: Bounds<Pixels>, look: &Painting, ink: usize) {
    let k = f32::from(area.size.width) / DESIGN;
    let frame = Frame::new(look.m, look.t);
    let class = size_class(f32::from(area.size.width));
    let (t, m) = (look.t, look.m);
    // Misregistration opens with the morph: the inks start in register on the key dots.
    let mis = (7. + 4. * (t * 1.2).sin()) * mis_of(class) * m;
    let mis2 = (-5. + 3. * (t * 0.95).cos()) * mis_of(class) * m;
    // Cross-fade the last halftone edge into the exact rest logo below M = 0.05.
    let blend = (m / 0.05).min(1.);
    match ink {
        1 if m > 0.001 => paint_dots(
            window,
            area,
            k,
            &frame,
            1,
            (mis, mis2),
            Hsla {
                alpha: 1.,
                ..look.blue
            },
        ),
        2 if m > 0.001 => paint_dots(
            window,
            area,
            k,
            &frame,
            2,
            (-mis2, mis * 0.6),
            Hsla {
                alpha: 1.,
                ..look.pink
            },
        ),
        0 => {
            if blend < 1. {
                paint_rest(
                    window,
                    area,
                    k,
                    Hsla {
                        alpha: look.key.alpha * (1. - blend),
                        ..look.key
                    },
                );
            }
            paint_dots(
                window,
                area,
                k,
                &frame,
                0,
                (0., 0.),
                Hsla {
                    alpha: blend,
                    ..look.key
                },
            );
            paint_ring(window, area, k, look.key);
        }
        _ => {}
    }
}

impl RenderOnce for ButlerThinkingMark {
    fn render(self, window: &mut Window, cx: &mut App) -> impl IntoElement {
        let now = cx.background_executor().now();
        let sim = self.simulation(window, cx);
        let breathe =
            window.use_keyed_state((self.id.clone(), "breathe"), cx, |_, _| Breathe::default());
        let ds = Ds::get(cx);
        let reduced = self.reduced_motion.unwrap_or_else(|| ds.reduced_motion());
        let working = self.state == MarkState::Working;
        let scope = if ds.dark() {
            MarkTheme::Dark
        } else {
            MarkTheme::Light
        };
        let theme = self.theme.unwrap_or(scope);
        let (blue, pink) = riso(theme, ds, scope);
        let breathing = reduced && working;
        let pulse = ds.duration(DsDuration::PulseDuration) * 2;
        let slow = ds.duration(DsDuration::MotionSlow);
        let spinner = ds.tokens().ease(Easing::SpinnerEasing);
        let standard = ds.tokens().ease(Easing::MotionEaseStandard);
        let (m, t, idle) = {
            let mut sim = sim.borrow_mut();
            if reduced {
                sim.park();
            } else {
                sim.update(now, working);
            }
            (sim.progress(), sim.time(), sim.idle)
        };
        let cadence = Cadence {
            pulse,
            slow,
            spinner,
            standard,
        };
        let (opacity, animating) = breathe.update(cx, |b, _| b.opacity(now, breathing, &cadence));
        if animating || (!reduced && !idle) {
            window.request_animation_frame();
        }
        let look = Painting {
            m,
            t,
            idle,
            key: key_ink(theme),
            blue,
            pink,
        };
        // Each riso ink prints as one layer at its own alpha, under the key ink.
        let stack = div()
            .relative()
            .size_full()
            .opacity(opacity)
            .child(layer(1, look.clone(), look.blue.alpha))
            .child(layer(2, look.clone(), look.pink.alpha))
            .child(layer(0, look, 1.));
        let mut frame = AspectFrame::new();
        if let Some(size) = self.size {
            frame = frame.size(size);
        }
        frame.child(stack)
    }
}
