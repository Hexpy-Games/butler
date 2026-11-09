//! `SpanBar.tsx` `SpanRow`: one trace row (usually a DisclosureRow) at its nesting depth. Every
//! row's bar lines up on the shared axis while titles show the nesting.
use std::rc::Rc;

use gpui::{
    AnyElement, App, ElementId, InteractiveElement as _, IntoElement, ParentElement, Pixels,
    RenderOnce, SharedString, Styled as _, Window, div, px,
};

use crate::tokens::Length;
use crate::ui::context::Ds;
use crate::ui::layout::{Space, Stack};

/// Text-indent mode indents at most this many levels; deeper rows show a depth cue instead
/// (`SPAN_TEXT_INDENT_CAP`).
pub const SPAN_TEXT_INDENT_CAP: u32 = 3;

/// How a row shows its depth.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub enum SpanIndent {
    /// The whole row indents 16px per level and its bar reaches back to the shared axis.
    #[default]
    Row,
    /// Only the row's text indents (16px per level, at most 3); the fill and the bar keep the
    /// full width. The row passes `text_indent` to `DisclosureRow::indent`.
    Text,
}

#[derive(IntoElement)]
pub struct SpanRow {
    id: ElementId,
    depth: u32,
    max_depth: u32,
    indent: SpanIndent,
    depth_label: Option<Rc<dyn Fn(u32) -> SharedString>>,
    children: Vec<AnyElement>,
}

impl SpanRow {
    pub fn new(id: impl Into<ElementId>) -> Self {
        Self {
            id: id.into(),
            depth: 0,
            max_depth: 0,
            indent: SpanIndent::Row,
            depth_label: None,
            children: Vec::new(),
        }
    }

    /// Nesting level of the span (0 for a root span).
    pub fn depth(mut self, depth: u32) -> Self {
        self.depth = depth;
        self
    }

    /// The trace's deepest level, the same on every row and on the `SpanAxis`. Row indent only:
    /// the shared axis moves right by the deepest indent.
    pub fn max_depth(mut self, max_depth: u32) -> Self {
        self.max_depth = max_depth;
        self
    }

    pub fn indent(mut self, indent: SpanIndent) -> Self {
        self.indent = indent;
        self
    }

    /// Text indent only: the cue a row deeper than 3 levels shows after its description, e.g.
    /// `|depth| format!("깊이 {depth}")`.
    pub fn depth_label(mut self, label: impl Fn(u32) -> SharedString + 'static) -> Self {
        self.depth_label = Some(Rc::new(label));
        self
    }

    /// What the row's `DisclosureRow` takes for `DisclosureRow::indent`: the levels to indent
    /// its text, and the depth cue past the cap. `(0, None)` unless the indent is `Text`.
    pub fn text_indent(&self) -> (u32, Option<SharedString>) {
        if self.indent != SpanIndent::Text {
            return (0, None);
        }
        let cue = (self.depth > SPAN_TEXT_INDENT_CAP)
            .then(|| self.depth_label.as_ref().map(|label| label(self.depth)))
            .flatten();
        (self.depth.min(SPAN_TEXT_INDENT_CAP), cue)
    }

    /// The `SpanBar::reach` of a bar in this row (`--span-reach`): the row's indent less the
    /// axis shift, so every row's track starts and ends at the same x. Negative above the
    /// deepest row. 0 for a text indent.
    pub fn reach(&self, cx: &App) -> Pixels {
        match self.indent {
            SpanIndent::Row => levels(self.depth, cx) - levels(self.max_depth, cx),
            SpanIndent::Text => px(0.),
        }
    }
}

/// `n` nesting steps of `--space-lg` (16px).
fn levels(n: u32, cx: &App) -> Pixels {
    Ds::get(cx).len(Length::SpaceLg) * f32::from(u16::try_from(n).unwrap_or(u16::MAX))
}

impl ParentElement for SpanRow {
    fn extend(&mut self, elements: impl IntoIterator<Item = AnyElement>) {
        self.children.extend(elements);
    }
}

/// Rows in a trace: `.row + .row { margin-top: var(--space-xs) }`.
pub fn span_rows(rows: impl IntoIterator<Item = SpanRow>) -> Stack {
    Stack::new().gap(Space::Xs).children(rows)
}

impl RenderOnce for SpanRow {
    fn render(self, _: &mut Window, cx: &mut App) -> impl IntoElement {
        let indent = match self.indent {
            SpanIndent::Row => levels(self.depth, cx),
            SpanIndent::Text => px(0.),
        };
        div()
            .id(self.id)
            .w_full()
            .pl(indent)
            .children(self.children)
    }
}
