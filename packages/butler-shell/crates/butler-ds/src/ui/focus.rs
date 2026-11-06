//! The focus ring (tokens.css --focus-ring, card section 0.2): a 2px outer spread that follows
//! the corner radius, shown on keyboard focus only, except in text fields (a browser treats any
//! focus of an input as focus-visible). A container that clips its content must leave
//! [`room`] around it.
use std::cell::{Cell, RefCell};

use gpui::{
    App, Bounds, BoxShadow, Corners, Div, FocusHandle, InteractiveElement as _, ParentElement as _,
    Pixels, Styled as _, Window, canvas,
};

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

/// The keyboard-focused control as it last painted: its box, and how far its ring reaches past it.
#[derive(Clone)]
pub struct Target {
    pub handle: FocusHandle,
    pub bounds: Bounds<Pixels>,
    pub ring: Pixels,
}

#[derive(Default)]
struct Published {
    target: RefCell<Option<Target>>,
    /// A scroller draws the focused control's ring this frame (card section 36, ring host).
    handed_off: Cell<bool>,
}

impl gpui::Global for Published {}

/// A zero-cost layer for a focused control: records its box (and `ring`, the reach of its ring)
/// while it paints, so a scroller that clips it can keep the ring clear of its fades.
pub fn publish(handle: FocusHandle, ring: Pixels) -> Div {
    gpui::div().absolute().size_full().top_0().left_0().child(
        canvas(
            |bounds, _, _| bounds,
            move |_, bounds, _, cx| {
                *cx.default_global::<Published>().target.borrow_mut() = Some(Target {
                    handle: handle.clone(),
                    bounds,
                    ring,
                });
            },
        )
        .absolute()
        .size_full(),
    )
}

/// What `handle` published when it last painted.
pub fn published(cx: &App, handle: &FocusHandle) -> Option<Target> {
    let published = cx.try_global::<Published>()?;
    let target = published.target.borrow();
    target.clone().filter(|target| &target.handle == handle)
}

/// A scroller takes over drawing the ring of the focused control inside it.
pub fn hand_off_ring(cx: &App) {
    if let Some(published) = cx.try_global::<Published>() {
        published.handed_off.set(true);
    }
}

pub fn ring_handed_off(cx: &App) -> bool {
    cx.try_global::<Published>()
        .is_some_and(|published| published.handed_off.get())
}

/// Starts a frame: no scroller holds a ring yet.
pub fn reset_hand_off(cx: &mut App) {
    cx.default_global::<Published>().handed_off.set(false);
}
