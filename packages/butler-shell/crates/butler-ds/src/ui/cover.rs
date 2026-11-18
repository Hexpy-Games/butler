//! The cover layer: a background, border or scrim box painted over its whole parent.
use gpui::{Div, Styled as _, div};

/// A layer over the whole box of its parent (the web's background/border box): pinned to the padding box, so padding or an earlier sibling never shifts it.
pub fn cover() -> Div {
    div().absolute().top_0().left_0().size_full()
}
