//! DS ProgressRing (ProgressRing.tsx / ProgressRing.module.css): a non-interactive ring in an
//! icon-sized square. Determinate: a `--context-track-bg` track with the tone's fill starting at
//! twelve o'clock and growing clockwise with round caps, the sweep gliding over `--motion-fast`
//! (none under reduced motion). Indeterminate: the DS Spinner in the same square.
use std::time::Instant;

use gpui::{
    App, ElementId, IntoElement, ParentElement as _, RenderOnce, Styled as _, Window, canvas, div,
    point, px,
};

use super::arc;
use super::context::Ds;
use super::convert;
use super::spinner::Spinner;
use crate::tokens::{Color, Density, Duration as DsDuration, Easing, Length, TokenContext};

/// `r 8` in the 20-unit view box.
const RADIUS: f32 = 8.; // DS: ProgressRing.tsx:9
const VIEW: f32 = 20.; // DS: ProgressRing.tsx:68

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub enum Size {
    Xs,
    Sm,
    #[default]
    Md,
    Lg,
    /// The sidebar's icon size.
    Sidebar,
    /// The ContextDonutButton's ring: 18px with a heavier stroke.
    Donut,
}

impl Size {
    /// The square, the stroke in view-box units and the Spinner drawn while indeterminate;
    /// `tokens` carry the sidebar density (`data-sidebar-density`) the sidebar size follows.
    fn metrics(self, tokens: &TokenContext) -> (f32, f32, f32) {
        if self == Self::Donut {
            return (18., 3.5, 18.); // DS: ContextDonutButton.module.css:33
        }
        let (length, stroke, spinner) = match self {
            Self::Xs => (Length::IconSizeXs, 3., Length::IconSizeXs), // DS: ProgressRing.module.css:12
            Self::Sm => (Length::IconSizeSm, 2.75, Length::IconSizeSm), // DS: ProgressRing.module.css:17
            Self::Md => (Length::IconSizeMd, 2.5, Length::IconSizeMd), // DS: ProgressRing.module.css:4
            Self::Lg => (Length::IconSizeLg, 2.25, Length::IconSizeLg), // DS: ProgressRing.module.css:22
            Self::Sidebar => (Length::SidebarIconSize, 1.875, Length::IconSizeMd), // DS: ProgressRing.module.css:28
            Self::Donut => unreachable!(),
        };
        (tokens.len(length), stroke, tokens.len(spinner))
    }
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub enum Tone {
    #[default]
    Default,
    Success,
    Warning,
    Danger,
}

#[derive(IntoElement)]
pub struct ProgressRing {
    id: ElementId,
    value: f32,
    indeterminate: bool,
    size: Size,
    tone: Tone,
    density: Option<Density>,
}

impl ProgressRing {
    pub fn new(id: impl Into<ElementId>) -> Self {
        Self {
            id: id.into(),
            value: 0.,
            indeterminate: false,
            size: Size::Md,
            tone: Tone::Default,
            density: None,
        }
    }

    /// The completed fraction, 0 to 1 (clamped; not finite is 0).
    pub fn value(mut self, value: f32) -> Self {
        self.value = if value.is_finite() {
            value.clamp(0., 1.)
        } else {
            0.
        };
        self
    }

    /// Work runs with no known fraction: the Spinner in the same square.
    pub fn indeterminate(mut self) -> Self {
        self.indeterminate = true;
        self
    }

    pub fn size(mut self, size: Size) -> Self {
        self.size = size;
        self
    }

    pub fn tone(mut self, tone: Tone) -> Self {
        self.tone = tone;
        self
    }

    /// The sidebar density in force where the ring sits (`data-sidebar-density` on an ancestor,
    /// which the `sidebar` size reads); unset, the app's.
    pub fn density(mut self, density: Density) -> Self {
        self.density = Some(density);
        self
    }
}

/// The sweep shown now, gliding to the value (`transition: stroke-dashoffset`).
struct Glide {
    from: f32,
    to: f32,
    since: Instant,
}

impl Glide {
    fn at(
        &self,
        now: Instant,
        duration: std::time::Duration,
        ease: &impl Fn(f32) -> f32,
    ) -> (f32, bool) {
        let total = duration.as_secs_f32();
        let elapsed = now.saturating_duration_since(self.since).as_secs_f32();
        if total <= 0. || elapsed >= total {
            (self.to, false)
        } else {
            (
                self.from + (self.to - self.from) * ease(elapsed / total),
                true,
            )
        }
    }
}

impl RenderOnce for ProgressRing {
    fn render(self, window: &mut Window, cx: &mut App) -> impl IntoElement {
        let ds = Ds::get(cx);
        let tokens = self.density.map_or(*ds.tokens(), |density| TokenContext {
            density,
            ..*ds.tokens()
        });
        let (side, stroke, spinner) = self.size.metrics(&tokens);
        if self.indeterminate {
            return div()
                .size(px(side))
                .flex_none()
                .child(Spinner::new((self.id, "spinner")).size(spinner).fit(side))
                .into_any_element();
        }
        let state = window.use_keyed_state((self.id.clone(), "sweep"), cx, {
            let value = self.value;
            move |_, _| Glide {
                from: value,
                to: value,
                since: Instant::now(),
            }
        });
        let now = cx.background_executor().now();
        let ds = Ds::get(cx);
        let duration = if ds.reduced_motion() {
            std::time::Duration::ZERO
        } else {
            ds.duration(DsDuration::MotionFast)
        };
        let ease = convert::easing(ds.tokens().ease(Easing::MotionEaseStandard));
        let (track, fill) = (ds.color(Color::ContextTrackBg), tone_color(ds, self.tone));
        let (shown, moving) = state.update(cx, |glide, _| {
            if (glide.to - self.value).abs() > f32::EPSILON {
                let (at, _) = glide.at(now, duration, &ease);
                *glide = Glide {
                    from: at,
                    to: self.value,
                    since: now,
                };
            }
            glide.at(now, duration, &ease)
        });
        if moving {
            window.request_animation_frame();
        }
        div()
            .size(px(side))
            .flex_none()
            .child(
                canvas(
                    |_, _, _| (),
                    move |bounds, (), window, _| {
                        let unit = f32::from(bounds.size.width) / VIEW;
                        let center = point(
                            bounds.origin.x + bounds.size.width / 2.,
                            bounds.origin.y + bounds.size.height / 2.,
                        );
                        arc::ring(window, center, RADIUS * unit, stroke * unit, track);
                        if shown > 0. {
                            let sweep = shown * std::f32::consts::TAU;
                            arc::stroke(
                                window,
                                center,
                                RADIUS * unit,
                                stroke * unit,
                                (arc::TOP, sweep),
                                fill,
                            );
                        }
                    },
                )
                .size_full(),
            )
            .into_any_element()
    }
}

fn tone_color(ds: &Ds, tone: Tone) -> gpui::Hsla {
    ds.color(match tone {
        Tone::Default => Color::Accent,
        Tone::Success => Color::ColorSuccess,
        Tone::Warning => Color::ColorWarning,
        Tone::Danger => Color::ColorDanger,
    })
}
