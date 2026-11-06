//! ScrollArea (DS blocks/ScrollArea) and the scroll-edge fade engine under it and under the Tabs
//! list. See [`engine`] for the fade, [`bar`] for the scrollbar.
mod area;
mod bar;
pub mod engine;

pub use area::{Bleed, MaxHeight, MinHeight, ScrollArea};
pub use engine::{Axis, Config, Fade, Flags, Scroller, fade, read, scroller};
