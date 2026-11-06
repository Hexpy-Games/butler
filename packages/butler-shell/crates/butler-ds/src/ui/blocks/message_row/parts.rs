//! The parts of a message row (MessageRow.tsx, MessageBubble.tsx, MessageTurnGroup.tsx): the
//! footer, the status row and its label (with the thinking shimmer), the bubble and the files
//! under it, and the group of rows of one turn.
use std::ops::Range;

use gpui::{
    AnyElement, App, HighlightStyle, IntoElement, ParentElement, RenderOnce, SharedString,
    Styled as _, StyledText, Window, div, px, relative,
};

use super::MessageRow;
use crate::tokens::{Color, Length, Number};
use crate::ui::blocks::scope::{self, ActionScale, Spec};
use crate::ui::context::Ds;
use crate::ui::convert;
use crate::ui::layout::{Space, Stack};
use crate::ui::motion::Loop;
use crate::ui::typo::Role;

/// The footer's icon actions keep a 26px row (`--icon-button-size`, DS: MessageRow.module.css:93).
const ACTION_SIDE: f32 = 26.;

/// `MessageFooter`: icon actions and metadata under a message, wrapping, in tertiary label type.
#[derive(IntoElement)]
pub struct MessageFooter {
    children: Vec<AnyElement>,
    flush: bool,
    end: bool,
}

impl MessageFooter {
    pub fn new() -> Self {
        Self {
            children: Vec::new(),
            flush: false,
            end: false,
        }
    }

    /// Aligned to the end edge (the footer slot of a row).
    pub fn end(mut self) -> Self {
        self.end = true;
        self
    }

    /// No `margin-top`: the footer sits in a row's footer slot, a code header, or directly in an
    /// assistant body (`.assistant .body > .footer`).
    pub fn flush(mut self) -> Self {
        self.flush = true;
        self
    }
}

impl Default for MessageFooter {
    fn default() -> Self {
        Self::new()
    }
}

impl ParentElement for MessageFooter {
    fn extend(&mut self, elements: impl IntoIterator<Item = AnyElement>) {
        self.children.extend(elements);
    }
}

impl RenderOnce for MessageFooter {
    fn render(self, _: &mut Window, cx: &mut App) -> impl IntoElement {
        let ds = Ds::get(cx);
        let mut row = div()
            .flex()
            .flex_wrap()
            .items_center()
            .gap(ds.len(Length::Space2))
            .mt(if self.flush {
                px(0.)
            } else {
                ds.len(Length::Space3)
            })
            .text_color(ds.color(Color::TextTertiary))
            .text_size(ds.len(Length::FontSize2))
            .line_height(ds.len(Length::TypoLabelLineHeight));
        if self.end {
            row = row.justify_end();
        }
        let row = row.children(self.children);
        scope::scoped(
            Spec {
                action: Some(ActionScale {
                    side: ACTION_SIDE,
                    icon: f32::from(ds.len(Length::IconSizeMd)),
                    fixed: false,
                }),
                ..Spec::default()
            },
            row,
        )
    }
}

/// One footer action in a code frame's header (the footer's 26px icon button scale, no margin).
pub fn footer_actions(action: impl IntoElement) -> AnyElement {
    MessageFooter::new()
        .flush()
        .child(action)
        .into_any_element()
}

/// `MessageStatusRow`: the status label's line, under the answer.
#[derive(IntoElement)]
pub struct MessageStatusRow {
    children: Vec<AnyElement>,
    flush: bool,
}

impl MessageStatusRow {
    pub fn new() -> Self {
        Self {
            children: Vec::new(),
            flush: false,
        }
    }

    /// No `margin-top`: a direct child of an assistant body, whose gap spaces it
    /// (`.assistant .body > .statusRow`).
    pub fn flush(mut self) -> Self {
        self.flush = true;
        self
    }
}

impl Default for MessageStatusRow {
    fn default() -> Self {
        Self::new()
    }
}

impl ParentElement for MessageStatusRow {
    fn extend(&mut self, elements: impl IntoIterator<Item = AnyElement>) {
        self.children.extend(elements);
    }
}

impl RenderOnce for MessageStatusRow {
    fn render(self, _: &mut Window, cx: &mut App) -> impl IntoElement {
        div()
            .flex()
            .min_w_0()
            .items_center()
            .mt(if self.flush {
                px(0.)
            } else {
                Ds::get(cx).len(Length::Space2)
            })
            .children(self.children)
    }
}

enum Content {
    Element(AnyElement),
    /// The label text and the type role it is set in, swept by the shimmer.
    Shimmer(Role, SharedString),
}

/// `MessageStatusLabel`: a mark and a label; `shimmer` sweeps a highlight across an in-progress
/// label (thinking, working).
#[derive(IntoElement)]
pub struct MessageStatusLabel {
    id: gpui::ElementId,
    mark: AnyElement,
    content: Option<Content>,
}

impl MessageStatusLabel {
    pub fn new(id: impl Into<gpui::ElementId>, mark: impl IntoElement) -> Self {
        Self {
            id: id.into(),
            mark: mark.into_any_element(),
            content: None,
        }
    }

    /// The label, any element (typically a caption).
    pub fn child(mut self, child: impl IntoElement) -> Self {
        self.content = Some(Content::Element(child.into_any_element()));
        self
    }

    /// An in-progress label: `text` in `role`, shimmering.
    pub fn shimmer(mut self, role: Role, text: impl Into<SharedString>) -> Self {
        self.content = Some(Content::Shimmer(role, text.into()));
        self
    }
}

/// The colour of the shimmer's text at fraction `x` of its width, `phase` (0 to 1) into a sweep:
/// `linear-gradient(90deg, secondary 40%, primary 50%, secondary 60%)` on a 250% wide image whose
/// position travels from 100% to 0%.
fn sweep(x: f32, phase: f32, secondary: gpui::Hsla, primary: gpui::Hsla) -> gpui::Hsla {
    let u = 0.6 * (1. - phase) + 0.4 * x;
    let weight = (1. - (u - 0.5).abs() / 0.1).max(0.);
    convert::mix(primary, secondary, weight)
}

fn shimmer_text(
    id: &gpui::ElementId,
    role: Role,
    text: &SharedString,
    window: &mut Window,
    cx: &mut App,
) -> AnyElement {
    let tick = window.use_keyed_state((id.clone(), "shimmer"), cx, |_, cx| {
        cx.background_executor().now()
    });
    let now = cx.background_executor().now();
    let begun = *tick.read(cx);
    let ds = Ds::get(cx);
    let (secondary, primary) = (ds.color(Color::TextSecondary), ds.color(Color::TextPrimary));
    let running = Loop::Decorative.runs(ds);
    let period = ds.duration(crate::tokens::Duration::ShimmerDuration);
    let spec = role.tokens();
    let body = ds.body_font().clone();
    let phase = if running {
        window.request_animation_frame();
        (now.saturating_duration_since(begun).as_secs_f32()
            / period.as_secs_f32().max(f32::EPSILON))
        .fract()
    } else {
        0.
    };
    let count = text.chars().count().max(1);
    let highlights: Vec<(Range<usize>, HighlightStyle)> = text
        .char_indices()
        .enumerate()
        .map(|(index, (at, c))| {
            let x = (index as f32 + 0.5) / count as f32;
            let color = if running {
                sweep(x, phase, secondary, primary)
            } else {
                secondary
            };
            (
                at..at + c.len_utf8(),
                HighlightStyle {
                    color: Some(color),
                    ..HighlightStyle::default()
                },
            )
        })
        .collect();
    let mut el = div().font_family(body).text_color(secondary);
    if let Some(spec) = spec {
        el = el
            .text_size(ds.len(spec.size))
            .line_height(ds.len(spec.line_height))
            .font_weight(gpui::FontWeight(ds.number(spec.weight)));
    }
    el.child(StyledText::new(text.clone()).with_highlights(highlights))
        .into_any_element()
}

impl RenderOnce for MessageStatusLabel {
    fn render(self, window: &mut Window, cx: &mut App) -> impl IntoElement {
        let content = match self.content {
            Some(Content::Element(el)) => el,
            Some(Content::Shimmer(role, text)) => shimmer_text(&self.id, role, &text, window, cx),
            None => div().into_any_element(),
        };
        let ds = Ds::get(cx);
        div()
            .flex()
            .min_w_0()
            .max_w(relative(1.))
            .items_center()
            .gap(ds.len(Length::Space2))
            .text_color(ds.color(Color::TextSecondary))
            .child(
                div()
                    .flex()
                    .flex_none()
                    .items_center()
                    .justify_center()
                    .size(px(18.)) // DS: MessageRow.module.css:196
                    .child(self.mark),
            )
            .child(div().flex_1().min_w_0().overflow_hidden().child(content))
    }
}

/// `MessageBubble`: the answer text of a bubble row, in the user bubble's shape, fill and width.
#[derive(IntoElement)]
pub struct MessageBubble {
    children: Vec<AnyElement>,
}

impl MessageBubble {
    pub fn new() -> Self {
        Self {
            children: Vec::new(),
        }
    }
}

impl Default for MessageBubble {
    fn default() -> Self {
        Self::new()
    }
}

impl ParentElement for MessageBubble {
    fn extend(&mut self, elements: impl IntoIterator<Item = AnyElement>) {
        self.children.extend(elements);
    }
}

impl RenderOnce for MessageBubble {
    fn render(self, _: &mut Window, cx: &mut App) -> impl IntoElement {
        let ds = Ds::get(cx);
        let bubble = div()
            .min_w_0()
            .rounded(ds.len(Length::RadiusPopover))
            .bg(ds.color(Color::UserMessageBg))
            .py(px(6.))
            .px(px(10.)) // DS: MessageRow.module.css:63
            .text_color(ds.color(Color::TextPrimary))
            .font_weight(gpui::FontWeight(ds.number(Number::FontWeightRegular)))
            .children(self.children);
        super::bubble_cap(bubble, false, false)
    }
}

/// `MessageBubbleAttachments`: files, cards and panels under a bubble, as wide as its maximum.
#[derive(IntoElement)]
pub struct MessageBubbleAttachments {
    children: Vec<AnyElement>,
}

impl MessageBubbleAttachments {
    pub fn new() -> Self {
        Self {
            children: Vec::new(),
        }
    }
}

impl Default for MessageBubbleAttachments {
    fn default() -> Self {
        Self::new()
    }
}

impl ParentElement for MessageBubbleAttachments {
    fn extend(&mut self, elements: impl IntoIterator<Item = AnyElement>) {
        self.children.extend(elements);
    }
}

impl RenderOnce for MessageBubbleAttachments {
    fn render(self, _: &mut Window, cx: &mut App) -> impl IntoElement {
        let column = div()
            .flex()
            .flex_col()
            .gap(Ds::get(cx).len(Length::SpaceLg))
            .min_w_0()
            .children(self.children);
        super::bubble_cap(column, true, false)
    }
}

/// `MessageTurnGroup`: the message and activity rows of one transcript turn, a `--space-lg`
/// apart in place of each row's own bottom padding.
#[derive(IntoElement)]
pub struct MessageTurnGroup {
    rows: Vec<MessageRow>,
}

impl MessageTurnGroup {
    pub fn new() -> Self {
        Self { rows: Vec::new() }
    }

    pub fn row(mut self, row: MessageRow) -> Self {
        self.rows.push(row);
        self
    }
}

impl Default for MessageTurnGroup {
    fn default() -> Self {
        Self::new()
    }
}

impl RenderOnce for MessageTurnGroup {
    fn render(self, _: &mut Window, _: &mut App) -> impl IntoElement {
        Stack::new()
            .gap(Space::Lg)
            .children(self.rows.into_iter().map(MessageRow::grouped))
    }
}
