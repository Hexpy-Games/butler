//! The overlay top layer (card section 0.6): floating surfaces are drawn after the whole tree,
//! in window coordinates, ordered by the DS z tokens, and keep clear of the titlebar. React
//! portals them to `document.body`; here a `Layer` element defers its child to the end of the
//! frame (the portal) and places it by its top-left corner in screen space (position: fixed).
use gpui::{
    Anchor, AnyElement, App, IntoElement, ParentElement as _, Pixels, Point, Window, anchored,
    deferred,
};

use super::context::Ds;
use crate::tokens::{Length, Number};

/// The DS z tokens, lowest to highest (`--z-sticky` .. `--z-drag`).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Z {
    Sticky,
    Drawer,
    Overlay,
    Dialog,
    Popover,
    Tooltip,
    Drag,
}

impl Z {
    fn token(self) -> Number {
        match self {
            Self::Sticky => Number::ZSticky,
            Self::Drawer => Number::ZDrawer,
            Self::Overlay => Number::ZOverlay,
            Self::Dialog => Number::ZDialog,
            Self::Popover => Number::ZPopover,
            Self::Tooltip => Number::ZTooltip,
            Self::Drag => Number::ZDrag,
        }
    }

    /// The token's stacking value.
    #[expect(
        clippy::cast_possible_truncation,
        clippy::cast_sign_loss,
        reason = "z tokens are small positive integers"
    )]
    pub fn value(self, ds: &Ds) -> usize {
        ds.number(self.token()).max(0.) as usize
    }
}

/// The titlebar safe area (`--titlebar-safe-area-top`, 56px): no overlay takes a top above it.
pub fn safe_top(ds: &Ds) -> f32 {
    f32::from(ds.len(Length::TitlebarSafeAreaTop))
}

/// An element drawn in the top layer at `z`, its top-left corner at `origin` (window px).
#[derive(IntoElement)]
pub struct Layer {
    z: Z,
    origin: Point<Pixels>,
    child: AnyElement,
}

impl Layer {
    pub fn new(z: Z, origin: Point<Pixels>, child: impl IntoElement) -> Self {
        Self {
            z,
            origin,
            child: child.into_any_element(),
        }
    }
}

impl gpui::RenderOnce for Layer {
    fn render(self, _: &mut Window, cx: &mut App) -> impl IntoElement {
        let priority = self.z.value(Ds::get(cx));
        deferred(
            anchored()
                .position(self.origin)
                .anchor(Anchor::TopLeft)
                .snap_to_window()
                .child(self.child),
        )
        .priority(priority)
    }
}
