//! The focus ring (tokens.css --focus-ring, card section 0.2): a 2px outer spread that follows
//! the corner radius, shown on keyboard focus only, except in text fields (a browser treats any
//! focus of an input as focus-visible). A container that clips its content must leave
//! [`room`] around it.
use gpui::{App, Bounds, BoxShadow, Corners, Div, InteractiveElement as _, Pixels, Window};

use super::context::{Ds, Modality};
use super::convert;
use crate::tokens::{Length, Shadow};

/// Paint room a clipping container leaves for the ring (--focus-ring-room: ring plus offset).
pub fn room(ds: &Ds) -> Pixels {
    ds.len(Length::FocusRingRoom)
}

/// The ring as box-shadow layers (`0 0 0 var(--focus-ring-width) var(--focus-ring-color)`).
pub fn shadows(ds: &Ds) -> Vec<BoxShadow> {
    convert::box_shadows(ds.tokens().shadow(Shadow::FocusRing), ds.tokens())
}

/// Whether a focused control shows its ring now.
pub fn visible(ds: &Ds, focused: bool, text_field: bool) -> bool {
    focused && (text_field || ds.modality() == Modality::Keyboard)
}

/// Paints the ring around `bounds` (outside it, never as a border: layout does not move).
pub fn paint(ds: &Ds, bounds: Bounds<Pixels>, radius: Pixels, window: &mut Window) {
    window.paint_drop_shadows_outside(bounds, Corners::all(radius), 0., &shadows(ds));
}

/// Records whether the last input was the keyboard or a pointer, for [`visible`]. Add it to the
/// window's root element once.
pub fn track_modality(root: Div) -> Div {
    root.capture_key_down(|_, _, cx| set_modality(cx, Modality::Keyboard))
        .capture_any_mouse_down(|_, _, cx| set_modality(cx, Modality::Pointer))
}

fn set_modality(cx: &mut App, modality: Modality) {
    if Ds::get(cx).modality() != modality {
        Ds::update(cx, |ds| ds.set_modality(modality));
        cx.refresh_windows();
    }
}
