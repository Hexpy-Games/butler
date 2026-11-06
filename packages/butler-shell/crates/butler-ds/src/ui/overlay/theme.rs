//! The theme context of an overlay layer (card section 0.1). React portals a surface out of the
//! themed shell, so the surface takes `theme` and re-applies the scope classes. Here every overlay
//! layer is given its [`Theme`] explicitly, defaulting to the one its trigger rendered in, and
//! renders its subtree under it: the `Ds` global carries that theme for the layer's layout,
//! prepaint and paint, then goes back to the page's.
use gpui::App;

use crate::ui::context::Ds;

/// The theme scope a layer renders in (`theme-light` or `theme-dark`).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Theme {
    pub dark: bool,
}

impl Theme {
    pub const LIGHT: Self = Self { dark: false };
    pub const DARK: Self = Self { dark: true };

    /// The theme of the tree being rendered now: what a trigger hands to its layer.
    pub fn current(cx: &App) -> Self {
        Self {
            dark: Ds::get(cx).dark(),
        }
    }

    /// Runs `f` with this theme in the `Ds` global, then restores the previous one.
    pub fn scoped<R>(self, cx: &mut App, f: impl FnOnce(&mut App) -> R) -> R {
        let previous = Ds::get(cx).dark();
        if previous != self.dark {
            Ds::update(cx, |ds| ds.set_dark(self.dark));
        }
        let result = f(cx);
        if previous != self.dark {
            Ds::update(cx, |ds| ds.set_dark(previous));
        }
        result
    }
}
