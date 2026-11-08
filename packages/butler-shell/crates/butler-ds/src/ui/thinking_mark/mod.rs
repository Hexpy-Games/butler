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
mod paint;

use std::cell::RefCell;
use std::collections::HashMap;
use std::rc::Rc;
use std::sync::Arc;

use gpui::{
    App, Bounds, ElementId, Hsla, IntoElement, ParentElement as _, Pixels, RenderOnce,
    SharedString, Styled as _, Window, canvas, div,
};

use self::morph::MorphSim;
pub use self::paint::Painter;
use self::paint::{Painting, paint_rest, paint_ring, paint_screen, square};
use super::aspect_frame::AspectFrame;
use super::context::Ds;
use super::convert;
use super::icon::IconSize;
use super::motion::{self, Props, Timing, looping, transition};
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

/// The reduced-motion breathe remembers its mount clock for the return to full opacity.
#[derive(Default)]
struct Breathe {
    since: Option<u32>,
}

/// The breathe's half-period and easing.
struct Cadence {
    pulse: Timing,
}

impl Breathe {
    fn opacity(&mut self, now: u32, breathing: bool, cadence: &Cadence) -> (f32, bool) {
        let since = if breathing {
            *self.since.get_or_insert(now)
        } else {
            let Some(since) = self.since.take() else {
                return (1., false);
            };
            since
        };
        let phase = (now.wrapping_sub(since) as f32 / cadence.pulse.ms() as f32).rem_euclid(2.);
        let q = if phase < 1. { phase } else { 2. - phase };
        (1. - 0.55 * cadence.pulse.ease(q), !breathing)
    }
}

/// The mark's canvas: static at rest; the same spring snapshot paints live or covered.
fn layer(
    key: u64,
    snapshot: MorphSim,
    look: Painting,
    reduced: bool,
) -> gpui::Canvas<Bounds<Pixels>> {
    canvas(
        |bounds, _, _| bounds,
        move |bounds, _, window, _| {
            let (area, k) = square(bounds);
            if reduced || snapshot.idle {
                paint_rest(window, area, k, look.key);
                paint_ring(window, area, k, look.key);
                return;
            }
            let paint = Arc::new(move |seconds: f32| {
                let mut frame = snapshot;
                frame.update(seconds, snapshot.working);
                Painting {
                    m: frame.progress(),
                    t: frame.time(),
                    ..look
                }
            });
            let live_paint = paint.clone();
            let live = Arc::new(move |seconds: f32, canvas: &mut gpui::LiveCanvas| {
                let (area, _) = square(Bounds::new(Default::default(), canvas.size()));
                let look = live_paint(seconds);
                for (ink, alpha) in [(1, look.blue.alpha), (2, look.pink.alpha), (0, 1.)] {
                    canvas.layer(area, alpha, |canvas| paint_screen(canvas, area, &look, ink));
                }
            });
            if !window.paint_live(key, bounds, snapshot.start_ms, live) {
                let seconds =
                    gpui::animation_time_ms().wrapping_sub(snapshot.start_ms) as f32 / 1000.;
                let look = paint(seconds);
                for (ink, alpha) in [(1, look.blue.alpha), (2, look.pink.alpha), (0, 1.)] {
                    window.layer(area, alpha, |window| paint_screen(window, area, &look, ink));
                }
                motion::live_fallback_frame(window);
            }
        },
    )
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

    fn simulation(&self, reduced: bool, window: &mut Window, cx: &mut App) -> MorphSim {
        let sim = if let Some(key) = &self.morph_key {
            let sims = cx.default_global::<SharedSims>();
            sims.0.borrow_mut().entry(key.clone()).or_default().clone()
        } else {
            window
                .use_keyed_state((self.id.clone(), "sim"), cx, |_, _| {
                    Rc::new(RefCell::new(MorphSim::default()))
                })
                .read(cx)
                .clone()
        };
        let now = gpui::animation_time_ms();
        let working = self.state == MarkState::Working;
        let mut sim = sim.borrow_mut();
        let leaving = sim.working && !working;
        let elapsed = now.wrapping_sub(sim.start_ms) as f32 / 1000.;
        if reduced {
            sim.park();
        } else {
            sim.update(elapsed, working);
        }
        sim.start_ms = now;
        if leaving && !reduced {
            let mut settle = *sim;
            let mut seconds = 0.;
            while !settle.idle {
                settle.update(0.05, false);
                seconds += 0.05;
            }
            motion::wake_after(window, cx, std::time::Duration::from_secs_f32(seconds));
        }
        *sim
    }
}

impl RenderOnce for ButlerThinkingMark {
    fn render(self, window: &mut Window, cx: &mut App) -> impl IntoElement {
        let now = gpui::animation_time_ms();
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
        let mut pulse = Timing::token(ds, DsDuration::PulseDuration, Easing::SpinnerEasing);
        pulse.duration *= 2;
        let cadence = Cadence { pulse };
        let slow = Timing::token(ds, DsDuration::MotionSlow, Easing::MotionEaseStandard);
        let snapshot = self.simulation(reduced, window, cx);
        let breathing = reduced && working;
        let (opacity, ended) = breathe.update(cx, |b, _| b.opacity(now, breathing, &cadence));
        if breathing || ended {
            transition(
                (self.id.clone(), "settle"),
                (opacity, true),
                &slow,
                window,
                cx,
            );
        }
        let settle = transition((self.id.clone(), "settle"), (1., false), &slow, window, cx);
        let start = breathe.read(cx).since.unwrap_or(now);
        let key = {
            use std::hash::{Hash, Hasher};
            let mut hash = std::hash::DefaultHasher::new();
            (window.current_view(), &self.id).hash(&mut hash);
            hash.finish()
        };
        let look = Painting {
            m: snapshot.progress(),
            t: snapshot.time(),
            key: key_ink(theme),
            blue,
            pink,
        };
        let drawing = layer(key, snapshot, look, reduced).absolute().size_full();
        let stack = div().relative().size_full().child(drawing);
        let stack = if breathing {
            looping(
                stack,
                &cadence.pulse,
                start,
                true,
                &Props {
                    opacity: Some((1., 0.45)),
                    ..Default::default()
                },
            )
        } else {
            settle.apply(
                stack,
                &slow,
                &Props {
                    opacity: Some((0., 1.)),
                    ..Default::default()
                },
            )
        };
        let mut frame = AspectFrame::new();
        if let Some(size) = self.size {
            frame = frame.size(size);
        }
        frame.child(stack)
    }
}
