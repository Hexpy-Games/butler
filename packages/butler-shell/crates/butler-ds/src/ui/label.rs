//! DS Label (label.tsx / Label.module.css): the name of a control.
use gpui::{
    AnyElement, App, FontWeight, IntoElement, ParentElement, RenderOnce, Styled as _, Window, div,
    px,
};

use super::context::Ds;
use crate::tokens::{Color, Length, Number};

/// `min-height: 18px`.
const MIN_HEIGHT: f32 = 18.; // DS: Label.module.css:3

#[derive(IntoElement)]
pub struct Label {
    children: Vec<AnyElement>,
}

impl Label {
    pub fn new() -> Self {
        Self {
            children: Vec::new(),
        }
    }
}

impl Default for Label {
    fn default() -> Self {
        Self::new()
    }
}

impl ParentElement for Label {
    fn extend(&mut self, elements: impl IntoIterator<Item = AnyElement>) {
        self.children.extend(elements);
    }
}

impl RenderOnce for Label {
    fn render(self, _: &mut Window, cx: &mut App) -> impl IntoElement {
        let ds = Ds::get(cx);
        let size = ds.len(Length::FontSize3);
        div()
            .flex()
            .items_center()
            .gap(ds.len(Length::Space2))
            .min_h(px(MIN_HEIGHT))
            .text_color(ds.color(Color::TextPrimary))
            .font_family(ds.body_font().clone())
            .text_size(size)
            .font_weight(FontWeight(ds.number(Number::FontWeightMedium)))
            .line_height(size)
            .children(self.children)
    }
}
