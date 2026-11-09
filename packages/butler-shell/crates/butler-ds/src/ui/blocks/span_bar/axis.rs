//! `SpanAxis.tsx`: time labels for a trace's shared axis, 0 at the start, the total at the end,
//! round steps between. Visual only; every `SpanBar` carries its own spoken label.
use std::rc::Rc;

use gpui::{
    AnyElement, App, ElementId, InteractiveElement as _, IntoElement, ParentElement as _, Pixels,
    RenderOnce, Styled as _, Window, div, px, relative,
};

use super::geometry::{DEFAULT_GAP, format_span_ms, narrow, span_ticks};
use crate::tokens::Length;
use crate::ui::blocks::measure;
use crate::ui::context::Ds;
use crate::ui::typo::{Tone, Typo, Wrap};

/// Room one tick label needs, start to start ("7.11s" at caption size plus a gap).
const LABEL_SPACING: f32 = 64.; // DS: SpanAxis.tsx:8

/// Where the axis starts and ends relative to the rows under it.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub enum SpanInset {
    /// The shared axis, moved right by the deepest indent.
    #[default]
    None,
    /// Starts where a DisclosureRow's description starts (row-indent `SpanRow`s).
    Disclosure,
    /// Spans the row inside its inset, as the `bar` of a DisclosureRow does (text-indent
    /// `SpanRow`s); `max_depth` does not apply.
    Row,
}

#[derive(IntoElement)]
pub struct SpanAxis {
    id: ElementId,
    total: f64,
    ticks: Option<Vec<f64>>,
    format: Rc<dyn Fn(f64) -> String>,
    inset: SpanInset,
    max_depth: u32,
}

impl SpanAxis {
    /// The whole trace, the same `total` every `SpanBar` of the trace gets.
    pub fn new(id: impl Into<ElementId>, total: f64) -> Self {
        Self {
            id: id.into(),
            total,
            ticks: None,
            format: Rc::new(format_span_ms),
            inset: SpanInset::None,
            max_depth: 0,
        }
    }

    /// Interior tick values; default 1, 2, 5 steps. 0 and the total are always shown.
    pub fn ticks(mut self, ticks: impl IntoIterator<Item = f64>) -> Self {
        self.ticks = Some(ticks.into_iter().collect());
        self
    }

    /// The tick label, e.g. ms to "2초". Default: "412ms" / "2s".
    pub fn format(mut self, format: impl Fn(f64) -> String + 'static) -> Self {
        self.format = Rc::new(format);
        self
    }

    pub fn inset(mut self, inset: SpanInset) -> Self {
        self.inset = inset;
        self
    }

    /// Row-indent traces: the deepest level, as passed to every `SpanRow`, so the axis moves
    /// with the bars.
    pub fn max_depth(mut self, max_depth: u32) -> Self {
        self.max_depth = max_depth;
        self
    }
}

/// How the label sits on its tick: the first starts at it, the last ends at it, the rest centre
/// on it (`.tick[data-edge]`). A zero-width box at the tick lets the label overflow either way.
fn tick(label: String, at: f64, edge: Edge) -> AnyElement {
    let anchor = div()
        .absolute()
        .top_0()
        .left(relative(narrow(at)))
        .w_0()
        .flex();
    let anchor = match edge {
        Edge::Start => anchor,
        Edge::Middle => anchor.justify_center(),
        Edge::End => anchor.justify_end(),
    };
    anchor
        .child(
            div().flex_none().child(
                Typo::caption(label)
                    .tone(Tone::Tertiary)
                    .tabular()
                    .wrap(Wrap::Nowrap),
            ),
        )
        .into_any_element()
}

#[derive(Clone, Copy)]
enum Edge {
    Start,
    Middle,
    End,
}

/// `n` nesting steps of `--space-lg` (16px): the shift of the shared axis.
fn shift(n: u32, cx: &App) -> Pixels {
    Ds::get(cx).len(Length::SpaceLg) * f32::from(u16::try_from(n).unwrap_or(u16::MAX))
}

impl RenderOnce for SpanAxis {
    fn render(self, window: &mut Window, cx: &mut App) -> impl IntoElement {
        let (size, recorder) = measure::track((self.id.clone(), "track"), window, cx);
        let ds = Ds::get(cx);
        let inset = ds.len(Length::SpaceSm);
        let shift = shift(self.max_depth, cx);
        let (start, end) = match self.inset {
            SpanInset::None => (shift, px(0.)),
            SpanInset::Disclosure => (inset + shift, inset),
            SpanInset::Row => (inset, inset),
        };
        // Tick density follows the axis width; before the first measure assume room for four
        // steps.
        let width = f64::from(f32::from(size.width));
        let gap = if width > 0. {
            (f64::from(LABEL_SPACING) / width).min(1.)
        } else {
            DEFAULT_GAP
        };
        let values = span_ticks(self.total, self.ticks.as_deref(), gap);
        let last = values.len().saturating_sub(1);
        let labels = values.iter().enumerate().map(|(position, value)| {
            let edge = match position {
                0 => Edge::Start,
                at if at == last => Edge::End,
                _ => Edge::Middle,
            };
            let at = if self.total > 0. {
                value / self.total
            } else {
                0.
            };
            tick((self.format)(*value), at, edge)
        });
        div().id(self.id).w_full().pl(start).pr(end).child(
            div()
                .relative()
                .h(ds.len(Length::TypoCaptionLineHeight))
                .children(labels)
                .child(recorder),
        )
    }
}
