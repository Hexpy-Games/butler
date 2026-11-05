//! DS Kbd (Kbd.tsx / Kbd.module.css): key caps in press order.
use gpui::{
    App, FontWeight, IntoElement, ParentElement as _, RenderOnce, SharedString, Styled as _,
    Window, div, px,
};

use super::context::Ds;
use crate::tokens::{Color, Length, Number};

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub enum KbdSize {
    Sm,
    #[default]
    Default,
}

#[derive(IntoElement)]
pub struct Kbd {
    keys: Vec<SharedString>,
    size: KbdSize,
}

impl Kbd {
    pub fn new(keys: impl IntoIterator<Item = impl Into<SharedString>>) -> Self {
        Self {
            keys: keys.into_iter().map(Into::into).collect(),
            size: KbdSize::Default,
        }
    }

    pub fn size(mut self, size: KbdSize) -> Self {
        self.size = size;
        self
    }
}

impl RenderOnce for Kbd {
    fn render(self, _: &mut Window, cx: &mut App) -> impl IntoElement {
        let ds = Ds::get(cx);
        let cap = ds.len(match self.size {
            KbdSize::Sm => Length::IconSizeLg,
            KbdSize::Default => Length::ControlHeightXs,
        });
        let font_size = ds.len(Length::TypoCaptionSize);
        let line_height = px(f32::from(font_size) * ds.number(Number::LineHeightNone));
        let key = |label: &SharedString| {
            div()
                .flex()
                .items_center()
                .justify_center()
                .min_w(cap)
                .h(cap)
                .px(ds.len(Length::SpaceXs))
                .border(ds.len(Length::BorderHairline))
                .border_b(ds.len(Length::BorderWidthStrong))
                .border_color(ds.color(Color::LineStrong))
                .rounded(ds.len(Length::RadiusControl))
                .bg(ds.color(Color::SurfaceRaised))
                .text_color(ds.color(Color::TextSecondary))
                .font_family(ds.body_font().clone())
                .text_size(font_size)
                .font_weight(FontWeight(ds.number(Number::FontWeightMedium)))
                .line_height(line_height)
                .child(label.clone())
        };
        div()
            .flex()
            .flex_none()
            .items_center()
            .gap(ds.len(Length::SpaceXs))
            .children(self.keys.iter().map(key))
    }
}
