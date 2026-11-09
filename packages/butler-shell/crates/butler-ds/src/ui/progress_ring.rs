//! DS ProgressRing (ProgressRing.tsx / ProgressRing.module.css): a non-interactive ring in an
//! icon-sized square. Determinate: a `--context-track-bg` track with the tone's fill starting at
//! twelve o'clock and growing clockwise with round caps, the sweep gliding over `--motion-fast`
//! (none under reduced motion). Indeterminate: the DS Spinner in the same square.

use gpui::{
    App, ElementId, IntoElement, ParentElement as _, RenderOnce, Styled as _, Window, canvas, div,
    px,
};

use super::arc;
use super::context::Ds;
use super::motion::{self, Timing, transition};
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
        let (length, stroke, spinner) = match self {
            Self::Xs => (Length::IconSizeXs, 3., Length::IconSizeXs), // DS: ProgressRing.module.css:12
            Self::Sm => (Length::IconSizeSm, 2.75, Length::IconSizeSm), // DS: ProgressRing.module.css:17
            Self::Md => (Length::IconSizeMd, 2.5, Length::IconSizeMd), // DS: ProgressRing.module.css:4
            Self::Lg => (Length::IconSizeLg, 2.25, Length::IconSizeLg), // DS: ProgressRing.module.css:22
            Self::Sidebar => (Length::SidebarIconSize, 1.875, Length::IconSizeMd), // DS: ProgressRing.module.css:28
            Self::Donut => return (18., 3.5, 18.), // DS: ContextDonutButton.module.css:33
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
        let ds = Ds::get(cx);
        let timing = if ds.reduced_motion() {
            Timing::linear(std::time::Duration::ZERO)
        } else {
            Timing::token(ds, DsDuration::MotionFast, Easing::MotionEaseStandard)
        };
        let (track, fill) = (ds.color(Color::ContextTrackBg), tone_color(ds, self.tone));
        let sweep = transition((self.id, "sweep"), (self.value, false), &timing, window, cx);
        let moving = sweep.moving(&timing);
        let linear = Timing::linear(timing.duration);
        let n = timing.ms().saturating_mul(60).div_ceil(1000).max(1);
        if moving {
            motion::wake_after(
                window,
                cx,
                std::time::Duration::from_millis(u64::from(
                    timing
                        .ms()
                        .saturating_sub(gpui::animation_time_ms().wrapping_sub(sweep.start_ms)),
                )),
            );
        }
        let frames = (0..if moving { n } else { 1 }).map(|i| {
            let shown = if moving {
                sweep.from + (sweep.to - sweep.from) * timing.ease((i + 1) as f32 / n as f32)
            } else {
                sweep.to
            };
            let frame = div().absolute().size_full().child(
                canvas(
                    |_, _, _| (),
                    move |bounds, (), window, _| {
                        let unit = f32::from(bounds.size.width) / VIEW;
                        let center = bounds.center();
                        arc::ring(window, center, RADIUS * unit, stroke * unit, track);
                        if shown > 0. {
                            arc::stroke(
                                window,
                                center,
                                RADIUS * unit,
                                stroke * unit,
                                (arc::TOP, shown * std::f32::consts::TAU),
                                fill,
                            );
                        }
                    },
                )
                .size_full(),
            );
            if moving {
                frame.motion(gpui::LayerMotion {
                    visible: (i as f32 / n as f32, (i + 1) as f32 / n as f32),
                    ..linear.motion(sweep.start_ms)
                })
            } else {
                frame
            }
        });
        div()
            .relative()
            .size(px(side))
            .flex_none()
            .children(frames)
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
