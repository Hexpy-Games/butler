//! DS ProgressMeter (ProgressMeter.tsx / ProgressMeter.module.css): a known value (0 to 100) on a
//! 6px track under a label row, a bare 4px track, a thin 2px load line, or an indeterminate
//! spinner beside one caption line. The fill eases to a new value over `--motion-deliberate`.
use gpui::{
    AnyElement, App, ElementId, IntoElement, ParentElement, RenderOnce, SharedString, Styled as _,
    Window, div, relative,
};

use crate::tokens::{Color, Duration as DsDuration, Easing, Length};
use crate::ui::context::Ds;
use crate::ui::icon_slot::{IconSlot, SlotSize, SlotTone};
use crate::ui::motion::{Timing, transition};
use crate::ui::spinner::Spinner;
use crate::ui::typo::{Tone, Typo};

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub enum MeterTone {
    #[default]
    Default,
    Success,
    Warning,
    Danger,
}

/// What the meter shows.
#[derive(Clone, Copy, Debug, PartialEq)]
enum Mode {
    Value(f32),
    Indeterminate,
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
enum Look {
    #[default]
    Labelled,
    /// The 4px track only.
    Bare,
    /// A 2px track on a clear rail, square ends.
    Thin,
}

#[derive(IntoElement)]
pub struct ProgressMeter {
    id: ElementId,
    mode: Mode,
    label: Option<SharedString>,
    meta: Option<SharedString>,
    meta_element: Option<AnyElement>,
    tone: MeterTone,
    look: Look,
}

impl ProgressMeter {
    /// A known value, 0 to 100 (clamped).
    pub fn new(id: impl Into<ElementId>, value: f32) -> Self {
        Self::with(id, Mode::Value(value.clamp(0., 100.)))
    }

    /// An unknown total: a spinner beside one caption line.
    pub fn indeterminate(id: impl Into<ElementId>) -> Self {
        Self::with(id, Mode::Indeterminate)
    }

    fn with(id: impl Into<ElementId>, mode: Mode) -> Self {
        Self {
            id: id.into(),
            mode,
            label: None,
            meta: None,
            meta_element: None,
            tone: MeterTone::Default,
            look: Look::Labelled,
        }
    }

    pub fn label(mut self, label: impl Into<SharedString>) -> Self {
        self.label = Some(label.into());
        self
    }

    pub fn meta(mut self, meta: impl Into<SharedString>) -> Self {
        self.meta = Some(meta.into());
        self
    }

    /// The meta as an element (an animated number), in the meta's caption voice.
    pub fn meta_element(mut self, meta: impl IntoElement) -> Self {
        self.meta_element = Some(meta.into_any_element());
        self
    }

    pub fn tone(mut self, tone: MeterTone) -> Self {
        self.tone = tone;
        self
    }

    /// The track only (4px), no label row.
    pub fn bare(mut self) -> Self {
        self.look = Look::Bare;
        self
    }

    /// A 2px track on a clear rail (a page's load line on the card edge); implies `bare`.
    pub fn thin(mut self) -> Self {
        self.look = Look::Thin;
        self
    }
}

impl ProgressMeter {
    fn track(&self, value: f32, window: &mut Window, cx: &mut App) -> AnyElement {
        let ds = Ds::get(cx);
        let timing = Timing::token(
            ds,
            DsDuration::MotionDeliberate,
            Easing::MotionEaseDecelerate,
        );
        let jump = ds.reduced_motion();
        let shown = transition(
            (self.id.clone(), "fill"),
            (value / 100., jump),
            &timing,
            window,
            cx,
        );
        let ds = Ds::get(cx);
        let fill = ds.color(match self.tone {
            MeterTone::Default => Color::Accent,
            MeterTone::Success => Color::ColorSuccess,
            MeterTone::Warning => Color::ColorWarning,
            MeterTone::Danger => Color::ColorDanger,
        });
        let track = div().w_full().overflow_hidden();
        let track = match self.look {
            Look::Labelled => track
                .h(gpui::px(6.)) // DS: ProgressMeter.module.css:14
                .rounded(ds.len(Length::RadiusPill))
                .bg(ds.color(Color::Selection)),
            Look::Bare => track
                .h(ds.len(Length::SpaceXs))
                .rounded(ds.len(Length::RadiusPill))
                .bg(ds.color(Color::Selection)),
            Look::Thin => track.h(ds.len(Length::BorderWidthStrong)),
        };
        let (size, probe) = super::measure::track((self.id.clone(), "track-size"), window, cx);
        let extent = shown.target();
        let clip = |value: f32| gpui::Edges {
            right: size.width * (1. - value),
            ..Default::default()
        };
        let mut motion = shown.motion(&timing);
        motion.clip = Some((clip(shown.from), clip(shown.to)));
        track
            .relative()
            .child(probe)
            .child(
                div()
                    .size_full()
                    .motion(motion)
                    .child(div().h_full().w(relative(extent)).bg(fill)),
            )
            .into_any_element()
    }
}

impl RenderOnce for ProgressMeter {
    fn render(self, window: &mut Window, cx: &mut App) -> impl IntoElement {
        let ds = Ds::get(cx);
        let gap_xs = ds.len(Length::SpaceXs);
        let gap_sm = ds.len(Length::SpaceSm);
        let tertiary = ds.color(Color::TextTertiary);
        let (caption_size, caption_line) = (
            ds.len(Length::TypoCaptionSize),
            ds.len(Length::TypoCaptionLineHeight),
        );
        let Mode::Value(value) = self.mode else {
            let text = match (&self.label, &self.meta) {
                (Some(label), Some(meta)) => format!("{label} · {meta}"),
                (Some(label), None) => label.to_string(),
                (None, Some(meta)) => format!(" · {meta}"),
                (None, None) => String::new(),
            };
            return div()
                .flex()
                .items_start()
                .w_full()
                .gap(gap_xs)
                .text_size(caption_size)
                .line_height(caption_line)
                .child(
                    IconSlot::new()
                        .size(SlotSize::Sm)
                        .min_line()
                        .tone(SlotTone::Secondary)
                        .child(Spinner::new((self.id, "spinner")).size(12.)),
                )
                .child(
                    div()
                        .min_w_0()
                        .child(Typo::caption(text).tone(Tone::Secondary)),
                )
                .into_any_element();
        };
        let track = self.track(value, window, cx);
        if self.look != Look::Labelled {
            return div().w_full().child(track).into_any_element();
        }
        let meta = match self.meta_element {
            Some(element) => div()
                .text_size(caption_size)
                .line_height(caption_line)
                .text_color(tertiary)
                .child(element)
                .into_any_element(),
            None => Typo::caption(
                self.meta
                    .clone()
                    .unwrap_or_else(|| format!("{}%", value.round()).into()),
            )
            .tone(Tone::Tertiary)
            .into_any_element(),
        };
        let label = self.label.clone().unwrap_or_default();
        div()
            .flex()
            .flex_col()
            .w_full()
            .gap(gap_xs)
            .child(
                div()
                    .flex()
                    .items_center()
                    .justify_between()
                    .gap(gap_sm)
                    .child(
                        div()
                            .min_w_0()
                            .child(Typo::caption(label).tone(Tone::Tertiary)),
                    )
                    .child(meta),
            )
            .child(track)
            .into_any_element()
    }
}
