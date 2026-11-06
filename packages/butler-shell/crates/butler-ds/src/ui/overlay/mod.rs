//! The infrastructure of the anchored overlays (card section 38 item 13): popper positioning
//! ([`place`], [`popper`]), the dismissable layer stack ([`dismiss`]), the open, exiting and
//! closed phases with the exit freeze ([`lifecycle`]), enter and exit motion ([`motion`]), the
//! focus scope ([`scope`]), roving focus and typeahead ([`roving`]), the explicit theme of a
//! layer ([`theme`]) and the modal scrim that locks scrolling. Popover, DropdownMenu,
//! ContextMenu and Select are built on it.
pub mod dismiss;
pub mod lifecycle;
pub mod motion;
pub mod place;
pub mod popper;
pub mod roving;
pub mod scope;
pub mod theme;

use gpui::{Div, InteractiveElement as _, Styled as _, Window, div, point, px};

use super::layer::{Layer, Z};

/// How an overlay presents itself (`OverlayPresentation`, card section 0.7).
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub enum Presentation {
    /// A bottom sheet below 768px, anchored above that.
    Auto,
    /// Anchored to the trigger: the app-wide default (`DEFAULT_OVERLAY_PRESENTATION`).
    #[default]
    Popover,
    /// Always a bottom sheet (`bottom_sheet::present`): the overlay keeps its keyboard,
    /// typeahead and dismissal and opens pinned to the bottom edge under a backdrop.
    Sheet,
}

/// `auto` becomes a sheet below this width (`(width < 768px)`).
const SHEET_BELOW: f32 = 768.; // DS: presentation.ts

impl Presentation {
    /// Whether the overlay is a bottom sheet in a window `width` wide.
    pub fn is_sheet(self, width: f32) -> bool {
        match self {
            Self::Auto => width < SHEET_BELOW,
            Self::Popover => false,
            Self::Sheet => true,
        }
    }
}

/// Dismisses the topmost overlay on Escape, wherever focus is (Radix listens on the document).
/// Add it to the window's root element once, next to `focus::track_modality`.
pub fn track(root: Div) -> Div {
    root.capture_key_down(|event, window, cx| {
        if event.keystroke.key == "escape" && dismiss::escape(window, cx) {
            cx.stop_propagation();
        }
    })
}

/// The scrim of a modal overlay: a transparent layer over the whole window that takes every
/// pointer and wheel event, so the page under it neither receives clicks nor scrolls (the
/// scroll lock and the blocked outside pointer events of Radix `modal`). Draw it before the
/// content layer at the same `z`.
pub fn scrim(z: Z, window: &Window) -> Layer {
    let size = window.viewport_size();
    Layer::new(
        z,
        point(px(0.), px(0.)),
        div().w(size.width).h(size.height).occlude(),
    )
}
