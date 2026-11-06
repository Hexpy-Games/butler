//! DS IconSlot (IconSlot.tsx / IconSlot.module.css): a fixed square that centres one glyph (row
//! glyphs, status marks, timeline markers). The glyph takes the row colour unless a tone is set.
//! `pointer-events: none` (`passive`) needs no code here: a slot has no handlers, so it already
//! lets pointer events through to the row beneath.
use gpui::{
    AnyElement, App, IntoElement, ParentElement, Pixels, RenderOnce, Styled as _, Window, div,
};

use super::context::Ds;
use crate::tokens::{Color, Length};

/// `sidebar` follows the sidebar density icon size; the rest are `--icon-size-*`.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub enum SlotSize {
    Sidebar,
    Xs,
    Sm,
    #[default]
    Md,
    Lg,
}

impl SlotSize {
    pub(crate) fn side(self, ds: &Ds) -> Pixels {
        ds.len(match self {
            Self::Sidebar => Length::SidebarIconSize,
            Self::Xs => Length::IconSizeXs,
            Self::Sm => Length::IconSizeSm,
            Self::Md => Length::IconSizeMd,
            Self::Lg => Length::IconSizeLg,
        })
    }
}

/// The glyph colour; omitted, the row's colour.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum SlotTone {
    Secondary,
    Tertiary,
}

#[derive(IntoElement)]
pub struct IconSlot {
    size: SlotSize,
    min_line: bool,
    tone: Option<SlotTone>,
    children: Vec<AnyElement>,
}

impl IconSlot {
    pub fn new() -> Self {
        Self {
            size: SlotSize::Md,
            min_line: false,
            tone: None,
            children: Vec::new(),
        }
    }

    pub fn size(mut self, size: SlotSize) -> Self {
        self.size = size;
        self
    }

    /// `minHeight="line"`: at least one line box tall (`min-height: 1lh`), so the slot sits on the
    /// text row.
    pub fn min_line(mut self) -> Self {
        self.min_line = true;
        self
    }

    pub fn tone(mut self, tone: SlotTone) -> Self {
        self.tone = Some(tone);
        self
    }
}

impl Default for IconSlot {
    fn default() -> Self {
        Self::new()
    }
}

impl ParentElement for IconSlot {
    fn extend(&mut self, elements: impl IntoIterator<Item = AnyElement>) {
        self.children.extend(elements);
    }
}

impl RenderOnce for IconSlot {
    fn render(self, window: &mut Window, cx: &mut App) -> impl IntoElement {
        let line = window.text_style().line_height_in_pixels(window.rem_size());
        let ds = Ds::get(cx);
        let side = self.size.side(ds);
        let slot = div()
            .flex()
            .flex_none()
            .items_center()
            .justify_center()
            .w(side);
        let slot = if self.min_line {
            slot.min_h(line)
        } else {
            slot.h(side)
        };
        let slot = match self.tone {
            Some(SlotTone::Secondary) => slot.text_color(ds.color(Color::TextSecondary)),
            Some(SlotTone::Tertiary) => slot.text_color(ds.color(Color::TextTertiary)),
            None => slot,
        };
        slot.children(self.children)
    }
}
