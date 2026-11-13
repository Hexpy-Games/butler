//! The parts of a message row (MessageRow.tsx, MessageBubble.tsx, MessageTurnGroup.tsx): the
//! footer, the status row and its label (with the thinking shimmer), the bubble and the files
//! under it, and the group of rows of one turn.

use gpui::{
    AnyElement, App, IntoElement, ParentElement, RenderOnce, SharedString, Styled as _, Window,
    div, px, relative,
};

use super::MessageRow;
use crate::tokens::{Color, Length, Number};
use crate::ui::blocks::scope::{self, ActionScale, Spec};
use crate::ui::context::Ds;
use crate::ui::layout::{Space, Stack};
use crate::ui::motion::{Loop, Timing, mounted_at};
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

/// The original triangular character weight on a linear, wrapping motion clock.
fn sweep(x: f32, start: u32, timing: &Timing) -> gpui::LayerMotion {
    let at = |u: f32| (0.6 + 0.4 * x - u) / 0.6;
    let points = [
        (0., 0.),
        (at(0.6), 0.),
        (at(0.5), 1.),
        (at(0.4), 0.),
        (1., 0.),
    ];
    gpui::LayerMotion {
        repeat: gpui::MotionRepeat::Loop,
        opacity: (0., 1.),
        easing: gpui::MotionEasing::linear(&points),
        ..timing.motion(start)
    }
}

/// The secondary text and character-clipped primary copies on the retained shimmer clock.
fn shimmer_text(
    id: &gpui::ElementId,
    role: Role,
    text: &SharedString,
    window: &mut Window,
    cx: &mut App,
) -> AnyElement {
    let start = mounted_at((id.clone(), "shimmer"), window, cx);
    let ds = Ds::get(cx);
    let (secondary, primary) = (ds.color(Color::TextSecondary), ds.color(Color::TextPrimary));
    let style = window.text_style();
    let (size, line_height, weight) = match role.tokens() {
        Some(spec) => (
            ds.len(spec.size),
            ds.len(spec.line_height),
            gpui::FontWeight(ds.number(spec.weight)),
        ),
        None => (
            style.font_size.to_pixels(window.rem_size()),
            style.line_height_in_pixels(window.rem_size()),
            style.font_weight,
        ),
    };
    let mut font = style.font();
    font.family = ds.body_font().clone();
    font.weight = weight;
    let line = window.text_system().shape_line(
        text.clone(),
        size,
        &[gpui::TextRun {
            len: text.len(),
            font: font.clone(),
            color: primary,
            letter_spacing: style.letter_spacing,
            ..Default::default()
        }],
    );
    let mut el = div()
        .relative()
        .font_family(font.family)
        .font_weight(font.weight)
        .text_size(size)
        .line_height(line_height)
        .text_color(secondary)
        .child(div().child(text.clone()));
    if Loop::Decorative.runs(ds) {
        let mut overlay = div().absolute().top_0().left_0().size_full();
        let timing = Timing::linear(ds.duration(crate::tokens::Duration::ShimmerDuration));
        for (at, character) in text.char_indices() {
            for bounds in line
                .platform_layout
                .selection_bounds(at..at + character.len_utf8(), line_height)
            {
                let (left, right) = (bounds.left(), bounds.right());
                let x = f32::from((left + right) / 2.) / f32::from(line.width());
                let copy = div()
                    .absolute()
                    .top_0()
                    .left(left)
                    .w(right - left)
                    .h(line_height)
                    .overflow_hidden()
                    .child(
                        div()
                            .relative()
                            .left(-left)
                            .w(line.width())
                            .text_color(primary)
                            .child(text.clone()),
                    );
                overlay = overlay.child(copy.motion(sweep(x, start, &timing)));
            }
        }
        el = el.child(overlay);
    }
    el.into_any_element()
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
                    // DS: MessageRow.module.css:205 `.statusMark > * { width:100%; height:100% }`
                    .child(div().size_full().child(self.mark)),
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
        super::bubble_cap(bubble, super::BUTLER_BUBBLE_SHARE, false, false)
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
        super::bubble_cap(column, super::BUTLER_BUBBLE_SHARE, true, false)
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
