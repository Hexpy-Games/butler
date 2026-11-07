//! Slot rects (`useSlotRects`): where every task slot sits, relative to the origin box the edges
//! are drawn in. gpui knows a box only after layout, so a recorder canvas inside each slot (and
//! one in the origin box) writes the slot's bounds while the frame is prepared; the edge canvas
//! reads them in the same frame's paint. Rects are in content coordinates, so scrolling never
//! changes them.
use std::collections::HashMap;

use gpui::{
    AnyElement, App, Bounds, Div, ElementId, Entity, FocusHandle, InteractiveElement as _,
    IntoElement as _, ParentElement as _, Pixels, Point, SharedString, Styled as _, Window, canvas,
    div, px,
};

use crate::tokens::Length;
use crate::ui::context::Ds;

/// One slot's box, in px relative to the origin box.
#[derive(Clone, Copy, Debug, Default, PartialEq)]
pub(crate) struct SlotRect {
    pub(crate) left: f32,
    pub(crate) right: f32,
    pub(crate) top: f32,
    pub(crate) mid_y: f32,
    /// Centre of the card's first IconSlot (its first text line).
    pub(crate) first_line_y: f32,
}

#[derive(Default)]
pub(crate) struct Measure {
    /// The origin box's window position on the last frame.
    pub(crate) origin: Point<Pixels>,
    rects: HashMap<SharedString, SlotRect>,
}

impl Measure {
    pub(crate) fn rect(&self, id: &SharedString) -> Option<SlotRect> {
        self.rects.get(id).copied()
    }

    fn record(&mut self, id: &SharedString, bounds: Bounds<Pixels>, first_line: Option<f32>) {
        let left = f32::from(bounds.left() - self.origin.x);
        let top = f32::from(bounds.top() - self.origin.y);
        let (width, height) = (f32::from(bounds.size.width), f32::from(bounds.size.height));
        let rect = SlotRect {
            left,
            right: left + width,
            top,
            mid_y: top + height / 2.,
            first_line_y: top + first_line.unwrap_or(height / 2.),
        };
        if self.rects.get(id) != Some(&rect) {
            self.rects.insert(id.clone(), rect);
        }
    }
}

pub(crate) fn state(
    id: impl Into<ElementId>,
    window: &mut Window,
    cx: &mut App,
) -> Entity<Measure> {
    window.use_keyed_state(id, cx, |_, _| Measure::default())
}

/// The origin box: absolute, filling its parent. It records its position first (tree order), then
/// `paint` draws with the origin and the slot rects of this frame.
pub(crate) fn origin(
    measure: &Entity<Measure>,
    paint: impl FnOnce(Point<Pixels>, &Measure, &mut Window) + 'static,
) -> AnyElement {
    let record = measure.clone();
    let read = measure.clone();
    canvas(
        move |bounds, _, cx| record.update(cx, |m, _| m.origin = bounds.origin),
        move |bounds, (), window, cx| paint(bounds.origin, read.read(cx), window),
    )
    .absolute()
    .top_0()
    .left_0()
    .size_full()
    .into_any_element()
}

/// A slot: `content` with a recorder over it, wrapped in the focus handle that tells which task
/// holds keyboard focus (`handle`, `None` for a dummy slot). `first_line` is the offset of the
/// card's first text line from the slot's top.
pub(crate) fn slot(
    (id, handle): (&SharedString, Option<&FocusHandle>),
    measure: &Entity<Measure>,
    first_line: Option<f32>,
    content: AnyElement,
) -> Div {
    let (measure, key) = (measure.clone(), id.clone());
    let recorder = canvas(
        move |bounds, _, cx| measure.update(cx, |m, _| m.record(&key, bounds, first_line)),
        |_, (), _, _| {},
    )
    .absolute()
    .top_0()
    .left_0()
    .size_full();
    let slot = div().relative().w_full().child(content).child(recorder);
    match handle {
        Some(handle) => slot.track_focus(handle),
        None => slot,
    }
}

/// Offset from a TaskGraphCard's top to the centre of its first IconSlot: the card border, the
/// `sm` padding, half the slot (a line box tall at least, a status glyph wide at least).
pub(crate) fn card_first_line(window: &Window, cx: &App) -> f32 {
    let ds = Ds::get(cx);
    let line = window.text_style().line_height_in_pixels(window.rem_size());
    let slot = f32::from(line.max(ds.len(Length::IconSizeMd)));
    1. + f32::from(ds.len(Length::Space2)) + slot / 2. // DS: Card.module.css:2
}

/// The pixel position `x`, `y` (relative to the origin) in the window.
pub(crate) fn at(origin: Point<Pixels>, x: f32, y: f32) -> Point<Pixels> {
    Point::new(origin.x + px(x), origin.y + px(y))
}
