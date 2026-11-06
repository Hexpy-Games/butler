//! PopoverHeader, PopoverTitle and PopoverDescription (Popover.module.css `.header`, `.title`,
//! `.description`).
use gpui::{
    AnyElement, App, FontWeight, IntoElement, ParentElement, RenderOnce, SharedString, Styled as _,
    Window, div, px,
};

use crate::tokens::{Color, Length, Number};
use crate::ui::context::Ds;

/// A column of title and description: `gap: 2px; font-size: var(--font-size-3)`.
#[derive(IntoElement, Default)]
pub struct PopoverHeader {
    children: Vec<AnyElement>,
}

impl PopoverHeader {
    pub fn new() -> Self {
        Self::default()
    }
}

impl ParentElement for PopoverHeader {
    fn extend(&mut self, elements: impl IntoIterator<Item = AnyElement>) {
        self.children.extend(elements);
    }
}

impl RenderOnce for PopoverHeader {
    fn render(self, _: &mut Window, cx: &mut App) -> impl IntoElement {
        let ds = Ds::get(cx);
        div()
            .flex()
            .flex_col()
            .gap(px(2.)) // DS: Popover.module.css:98
            .text_size(ds.len(Length::FontSize3))
            .children(self.children)
    }
}

/// The title: semibold.
#[derive(IntoElement)]
pub struct PopoverTitle(SharedString);

impl PopoverTitle {
    pub fn new(text: impl Into<SharedString>) -> Self {
        Self(text.into())
    }
}

impl RenderOnce for PopoverTitle {
    fn render(self, _: &mut Window, cx: &mut App) -> impl IntoElement {
        let ds = Ds::get(cx);
        div()
            .font_weight(FontWeight(ds.number(Number::FontWeightSemibold)))
            .child(self.0)
    }
}

/// The description: secondary text.
#[derive(IntoElement)]
pub struct PopoverDescription(SharedString);

impl PopoverDescription {
    pub fn new(text: impl Into<SharedString>) -> Self {
        Self(text.into())
    }
}

impl RenderOnce for PopoverDescription {
    fn render(self, _: &mut Window, cx: &mut App) -> impl IntoElement {
        let ds = Ds::get(cx);
        div()
            .text_color(ds.color(Color::TextSecondary))
            .child(self.0)
    }
}
