//! A DS icon at a token size, drawn in the inherited text colour (`currentColor`). gpui paints an
//! svg only in a colour set on the svg itself, so the colour is read from the text style the
//! icon is laid out in.
use gpui::{
    App, IntoElement, Pixels, RenderOnce, SharedString, Styled as _, Transformation, Window, svg,
};

use super::Icon;
use super::context::Ds;
use crate::tokens::Length;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum IconSize {
    Xs,
    Sm,
    Md,
    Lg,
    Xl,
    Xxl,
    Xxxl,
}

#[derive(IntoElement)]
pub struct IconView {
    icon: Icon,
    side: Pixels,
    turn: f32,
}

impl IconView {
    /// Turned clockwise by `radians` about its centre.
    pub fn turned(mut self, radians: f32) -> Self {
        self.turn = radians;
        self
    }
}

/// A DS icon at an exact pixel size.
pub fn icon_px(icon: Icon, side: Pixels) -> IconView {
    IconView {
        icon,
        side,
        turn: 0.,
    }
}

pub fn icon(icon: Icon, size: IconSize, ds: &Ds) -> IconView {
    let side = ds.len(match size {
        IconSize::Xs => Length::IconSizeXs,
        IconSize::Sm => Length::IconSizeSm,
        IconSize::Md => Length::IconSizeMd,
        IconSize::Lg => Length::IconSizeLg,
        IconSize::Xl => Length::IconSizeXl,
        IconSize::Xxl => Length::IconSize2xl,
        IconSize::Xxxl => Length::IconSize3xl,
    });
    icon_px(icon, side)
}

impl RenderOnce for IconView {
    fn render(self, window: &mut Window, cx: &mut App) -> impl IntoElement {
        // A SidebarShell sizes every svg in it (`.shell svg`, SidebarShell.module.css:45).
        let side = super::blocks::scope::svg_size(cx).map_or(self.side, gpui::px);
        let mut glyph = svg().path(SharedString::from(self.icon.path()));
        if self.turn != 0. {
            glyph = glyph.with_transformation(Transformation::rotate(gpui::radians(self.turn)));
        }
        glyph
            .size(side)
            .flex_none()
            .text_color(window.text_style().color)
    }
}
