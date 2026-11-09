//! `SpanBar.tsx` `SpanBar`: one span on a trace's shared time axis, a pill on a 6px track placed
//! by its start offset and sized by its duration (at least 3px). With segments the pill splits
//! into its children's pieces: rounded outer ends, square inner joints. No text, no interaction.
use gpui::{
    AnyElement, App, ElementId, InteractiveElement as _, IntoElement, ParentElement as _, Pixels,
    RenderOnce, SharedString, Styled as _, Window, div, pattern_slash, px, relative,
};

use super::geometry::{Child, Piece, narrow, span_fraction, span_pieces};
use crate::tokens::{Color, Length};
use crate::ui::context::Ds;

/// `.track` height.
const TRACK: f32 = 6.; // DS: SpanBar.module.css:21
/// `--span-min-width`.
const MIN_WIDTH: f32 = 3.; // DS: SpanBar.module.css:9
/// A hatch stripe and its period (`repeating-linear-gradient(135deg, fill 0 2px, alt 2px 4px)`).
const STRIPE: f32 = 2.; // DS: SpanBar.module.css:98
const PERIOD: f32 = 4.; // DS: SpanBar.module.css:98

/// What a span is (model, tool, app, agent) or its status (error, wait); each maps to its
/// `--trace-*` fill and `-alt` hatch partner (`SpanBarTone`).
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub enum SpanTone {
    #[default]
    Model,
    Tool,
    App,
    Agent,
    Error,
    Wait,
}

impl SpanTone {
    /// The tone a trace record names (`model`, `tool`, `app`, `agent`, `error`, `wait`).
    pub fn parse(name: &str) -> Option<Self> {
        Some(match name {
            "model" => Self::Model,
            "tool" => Self::Tool,
            "app" => Self::App,
            "agent" => Self::Agent,
            "error" => Self::Error,
            "wait" => Self::Wait,
            _ => return None,
        })
    }

    fn pair(self) -> (Color, Color) {
        match self {
            Self::Model => (Color::TraceModel, Color::TraceModelAlt),
            Self::Tool => (Color::TraceTool, Color::TraceToolAlt),
            Self::App => (Color::TraceApp, Color::TraceAppAlt),
            Self::Agent => (Color::TraceAgent, Color::TraceAgentAlt),
            Self::Error => (Color::TraceError, Color::TraceErrorAlt),
            Self::Wait => (Color::TraceWait, Color::TraceWaitAlt),
        }
    }
}

/// A direct child of the span: where it sits on the trace and its tone (`SpanBarSegment`).
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct SpanSegment {
    pub offset: f64,
    pub duration: f64,
    pub tone: SpanTone,
}

#[derive(IntoElement)]
pub struct SpanBar {
    id: ElementId,
    offset: f64,
    duration: f64,
    total: f64,
    tone: SpanTone,
    segments: Vec<Child<SpanTone>>,
    reach: Pixels,
    label: Option<SharedString>,
}

impl SpanBar {
    /// `offset` is the span's start and `total` the whole trace, in one unit (ms from the trace
    /// start); every bar of a trace shares `total`, so bars line up on one axis.
    pub fn new(id: impl Into<ElementId>, offset: f64, duration: f64, total: f64) -> Self {
        Self {
            id: id.into(),
            offset,
            duration,
            total,
            tone: SpanTone::Model,
            segments: Vec::new(),
            reach: px(0.),
            label: None,
        }
    }

    /// The span's own fill, and the fill of its time no child covers. Default `Model`.
    pub fn tone(mut self, tone: SpanTone) -> Self {
        self.tone = tone;
        self
    }

    /// One per direct child, in trace time. The whole span stays filled; each child paints its
    /// piece, adjacent children alternating solid and hatch.
    pub fn segments(mut self, segments: impl IntoIterator<Item = SpanSegment>) -> Self {
        self.segments = segments
            .into_iter()
            .map(|segment| (segment.offset, segment.duration, segment.tone))
            .collect();
        self
    }

    /// Row position, which staggers the grow-in by `--motion-stagger-row` per row.
    // ANIM-MIGRATE(the bar grows in from its start over --motion-deliberate, a row at a time,
    // fading in place under reduced motion; tone changes cross-fade over --motion-base): the DS
    // has no mount animation that starts below its target, so the bar shows its end state.
    pub fn index(self, _: usize) -> Self {
        self
    }

    /// How far the bar reaches back to the trace's shared axis (`--span-reach`): the row's
    /// indent less the axis shift, `SpanRow::reach`. 0 outside a row-indent `SpanRow`.
    pub fn reach(mut self, reach: Pixels) -> Self {
        self.reach = reach;
        self
    }

    /// The spoken text for the bar, e.g. "시작 +0.58초, 2.00초".
    pub fn label(mut self, label: impl Into<SharedString>) -> Self {
        self.label = Some(label.into());
        self
    }

    pub fn aria_label(&self) -> Option<&SharedString> {
        self.label.as_ref()
    }
}

/// One piece of the pill, placed by fractions of the pill; at least 1px so a short child stays
/// visible.
fn paint_piece(each: &Piece<SpanTone>, cx: &App) -> AnyElement {
    let ds = Ds::get(cx);
    let (fill, alt) = each.tone.pair();
    let base = div()
        .absolute()
        .top_0()
        .bottom_0()
        .left(relative(narrow(each.start)))
        .w(relative(narrow(each.width)))
        .min_w(px(1.));
    if !each.hatch {
        return base.bg(ds.color(fill)).into_any_element();
    }
    base.bg(ds.color(alt))
        .child(
            div()
                .size_full()
                .bg(pattern_slash(ds.color(fill), STRIPE, PERIOD)),
        )
        .into_any_element()
}

impl RenderOnce for SpanBar {
    fn render(self, _: &mut Window, cx: &mut App) -> impl IntoElement {
        let ds = Ds::get(cx);
        let pill = ds.len(Length::RadiusPill);
        let gap = ds.len(Length::SpaceXs);
        let fraction = span_fraction(self.offset, self.duration, self.total);
        let pieces = if self.segments.is_empty() {
            Vec::new()
        } else {
            span_pieces(
                fraction.start * self.total,
                fraction.width * self.total,
                self.tone,
                &self.segments,
            )
        };
        // The bar is one pill that clips its pieces, so only its outer ends are round. The
        // spacer before it shrinks when the minimum width would pass the end: `left` is
        // `min(start, 100% - 3px)`.
        let bar = div()
            .relative()
            .flex_none()
            .h_full()
            .min_w(px(MIN_WIDTH))
            .w(relative(narrow(fraction.width)))
            .overflow_hidden()
            .rounded(pill)
            .bg(ds.color(self.tone.pair().0))
            .children(pieces.iter().map(|each| paint_piece(each, cx)));
        let track = div()
            .absolute()
            .top(gap)
            .left(px(-f32::from(self.reach)))
            .right_0()
            .h(px(TRACK))
            .flex()
            .rounded(pill)
            .bg(ds.color(Color::Selection))
            .child(div().min_w_0().w(relative(narrow(fraction.start))))
            .child(bar);
        div()
            .id(self.id)
            .relative()
            .w_full()
            .h(gap + px(TRACK))
            .child(track)
    }
}
