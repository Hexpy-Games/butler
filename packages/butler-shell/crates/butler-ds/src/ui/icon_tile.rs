//! DS IconTile (IconTile.tsx / IconTile.module.css): a rounded square that holds one glyph (a
//! service logo, a point in a consent list, the state glyph of a setup screen). Decorative.
use gpui::{
    AnyElement, App, IntoElement, ParentElement, RenderOnce, Styled as _, Window, div, px, relative,
};

use super::context::Ds;
use crate::tokens::{Color, Length};

/// `sm` 28px, `md` 36px (default), `lg` 56px, `xl` 64px.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub enum TileSize {
    Sm,
    #[default]
    Md,
    Lg,
    Xl,
}

/// `neutral` raised square, `accent` info tint, `danger` error glyph, `plain` no surface.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub enum TileTone {
    #[default]
    Neutral,
    Accent,
    Danger,
    Plain,
}

#[derive(IntoElement)]
pub struct IconTile {
    size: TileSize,
    tone: TileTone,
    children: Vec<AnyElement>,
}

impl IconTile {
    pub fn new() -> Self {
        Self {
            size: TileSize::Md,
            tone: TileTone::Neutral,
            children: Vec::new(),
        }
    }

    pub fn size(mut self, size: TileSize) -> Self {
        self.size = size;
        self
    }

    pub fn tone(mut self, tone: TileTone) -> Self {
        self.tone = tone;
        self
    }

    /// An animated mark sizes to its container: half the tile, the whole of a plain one.
    pub fn mark(mut self, mark: impl IntoElement) -> Self {
        let share = if self.tone == TileTone::Plain {
            1.
        } else {
            0.5
        };
        self.children
            .push(div().w(relative(share)).child(mark).into_any_element());
        self
    }
}

impl Default for IconTile {
    fn default() -> Self {
        Self::new()
    }
}

impl ParentElement for IconTile {
    fn extend(&mut self, elements: impl IntoIterator<Item = AnyElement>) {
        self.children.extend(elements);
    }
}

impl RenderOnce for IconTile {
    fn render(self, _: &mut Window, cx: &mut App) -> impl IntoElement {
        let ds = Ds::get(cx);
        let (side, radius) = match self.size {
            TileSize::Sm => (28., Length::RadiusControl), // DS: IconTile.module.css:34
            TileSize::Md => (36., Length::RadiusControl), // DS: IconTile.module.css:9
            TileSize::Lg => (56., Length::RadiusPopover), // DS: IconTile.module.css:44
            TileSize::Xl => (64., Length::RadiusPopover), // DS: IconTile.module.css:50
        };
        let none = gpui::transparent_black();
        let (border, fill, ink) = match self.tone {
            TileTone::Neutral => (
                ds.color(Color::Line),
                ds.color(Color::Muted),
                ds.color(Color::TextPrimary),
            ),
            TileTone::Accent => (
                none,
                ds.color(Color::ColorInfoBg),
                ds.color(Color::ColorInfoText),
            ),
            TileTone::Danger => (
                ds.color(Color::Line),
                ds.color(Color::Muted),
                ds.color(Color::Danger),
            ),
            TileTone::Plain => (none, none, ds.color(Color::TextPrimary)),
        };
        div()
            .flex()
            .flex_none()
            .items_center()
            .justify_center()
            .size(px(side))
            .border(ds.len(Length::BorderHairline))
            .border_color(border)
            .rounded(ds.len(radius))
            .bg(fill)
            .text_color(ink)
            .children(self.children)
    }
}
