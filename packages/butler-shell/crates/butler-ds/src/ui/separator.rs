//! DS Separator (separator.tsx / Separator.module.css): a box of `space` with a 1px line
//! centred in it.
use gpui::{
    App, Bounds, IntoElement, RenderOnce, Styled as _, Window, canvas, div, point, prelude::*, px,
    size,
};

use super::context::Ds;
use super::convert;
use super::layout::Space;
use crate::tokens::{Color, Length};

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub enum Orientation {
    #[default]
    Horizontal,
    Vertical,
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub enum SeparatorTone {
    #[default]
    Default,
    Strong,
    Muted,
    Accent,
}

/// `color-mix(in srgb, var(--accent) 42%, transparent)`.
const ACCENT_SHARE: f32 = 0.42; // DS: Separator.module.css:14

#[derive(IntoElement)]
pub struct Separator {
    orientation: Orientation,
    line: bool,
    space: Space,
    tone: SeparatorTone,
}

impl Separator {
    pub fn new() -> Self {
        Self {
            orientation: Orientation::Horizontal,
            line: true,
            space: Space::Sm,
            tone: SeparatorTone::Default,
        }
    }

    pub fn vertical(mut self) -> Self {
        self.orientation = Orientation::Vertical;
        self
    }

    /// `line=false`: whitespace only.
    pub fn no_line(mut self) -> Self {
        self.line = false;
        self
    }

    pub fn space(mut self, space: Space) -> Self {
        self.space = space;
        self
    }

    pub fn tone(mut self, tone: SeparatorTone) -> Self {
        self.tone = tone;
        self
    }
}

impl Default for Separator {
    fn default() -> Self {
        Self::new()
    }
}

impl RenderOnce for Separator {
    fn render(self, _: &mut Window, cx: &mut App) -> impl IntoElement {
        let ds = Ds::get(cx);
        let space = self.space.px(ds);
        let color = match self.tone {
            SeparatorTone::Default => ds.color(Color::Line),
            SeparatorTone::Strong => ds.color(Color::LineStrong),
            SeparatorTone::Muted => ds.color(Color::Selection),
            SeparatorTone::Accent => convert::with_alpha(ds.color(Color::Accent), ACCENT_SHARE),
        };
        let line = self.line;
        let vertical = self.orientation == Orientation::Vertical;
        let hairline = px(1.); // DS: Separator.module.css:61
        let paint =
            move |bounds: Bounds<gpui::Pixels>, (): (), window: &mut Window, _: &mut App| {
                if !line {
                    return;
                }
                let rect = if vertical {
                    Bounds::new(
                        point(
                            bounds.origin.x + (bounds.size.width - hairline) / 2.,
                            bounds.origin.y,
                        ),
                        size(hairline, bounds.size.height),
                    )
                } else {
                    Bounds::new(
                        point(
                            bounds.origin.x,
                            bounds.origin.y + (bounds.size.height - hairline) / 2.,
                        ),
                        size(bounds.size.width, hairline),
                    )
                };
                window.paint_quad(gpui::PaintQuad::new(rect).background(color));
            };
        let base = div().relative().flex_none();
        let base = if vertical {
            // `1lh`: the inherited line height, the body role's.
            base.self_stretch()
                .w(space)
                .min_h(ds.len(Length::TypoBodyLineHeight))
        } else {
            base.w_full().h(space)
        };
        base.child(
            canvas(|_, _, _| (), paint)
                .absolute()
                .top_0()
                .left_0()
                .size_full(),
        )
    }
}
