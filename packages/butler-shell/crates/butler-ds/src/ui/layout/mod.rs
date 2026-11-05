//! Layout primitives (DS Box, Stack, Inline, Grid) and the item props they share.
mod box_;
mod grid;
mod item;
mod stack;

pub use box_::{Border, Box, Elevation, Radius, Surface};
pub use grid::{Columns, Grid, GridCross, GridItem, Preset, Responsive};
pub use item::{AlignSelf, Basis, ItemProps, MaxWidth, MinWidth, Span, WithItem};
pub use stack::{Align, Cross, Inline, Justify, Stack, StackItem, WindowDrag};

use gpui::Pixels;

use super::context::Ds;
use crate::tokens::{Length, Number};

/// The DS space scale (`--space-none` .. `--space-2xl`).
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub enum Space {
    None,
    Xs,
    Sm,
    #[default]
    Md,
    Lg,
    Xl,
    Xxl,
}

impl Space {
    pub fn px(self, ds: &Ds) -> Pixels {
        match self {
            Self::None => gpui::px(ds.number(Number::SpaceNone)),
            Self::Xs => ds.len(Length::SpaceXs),
            Self::Sm => ds.len(Length::SpaceSm),
            Self::Md => ds.len(Length::SpaceMd),
            Self::Lg => ds.len(Length::SpaceLg),
            Self::Xl => ds.len(Length::SpaceXl),
            Self::Xxl => ds.len(Length::Space2xl),
        }
    }
}
