//! ScrollArea (DS blocks/ScrollArea) and the scroll-edge fade engine under it and under the Tabs
//! list. See [`engine`] for the fade, [`bar`] for the scrollbar.
mod area;
pub(crate) mod bar;
pub mod engine;

pub(crate) use area::overlay;
pub use area::{Bleed, MaxHeight, MinHeight, ScrollArea};
pub use engine::{Axis, Config, Fade, Flags, Scroller, fade, read, scroller};
