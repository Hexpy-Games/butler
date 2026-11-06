//! A DS icon at a token size, drawn in the inherited text colour (`currentColor`). gpui paints an
//! svg only in a colour set on the svg itself, so the colour is read from the text style the
//! icon is laid out in.
use gpui::{App, IntoElement, Pixels, RenderOnce, SharedString, Styled as _, Window, svg};

use super::Icon;
use super::context::Ds;
use crate::tokens::Length;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum IconSize {
    Xs,
    Sm,
    Md,
    Lg,
}

#[derive(IntoElement)]
pub struct IconView {
    icon: Icon,
    side: Pixels,
}

pub fn icon(icon: Icon, size: IconSize, ds: &Ds) -> IconView {
    let side = ds.len(match size {
        IconSize::Xs => Length::IconSizeXs,
        IconSize::Sm => Length::IconSizeSm,
        IconSize::Md => Length::IconSizeMd,
        IconSize::Lg => Length::IconSizeLg,
    });
    IconView { icon, side }
}

impl RenderOnce for IconView {
    fn render(self, window: &mut Window, _: &mut App) -> impl IntoElement {
        svg()
            .path(SharedString::from(self.icon.path()))
            .size(self.side)
            .flex_none()
            .text_color(window.text_style().color)
    }
}
