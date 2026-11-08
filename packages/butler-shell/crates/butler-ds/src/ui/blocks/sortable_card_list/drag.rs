//! The drag session of a SortableCardList (`SortableCardList.tsx`, dnd-kit `closestCenter`):
//! the row under the pointer by nearest centre, the drop that moves the dragged card to that
//! row's place (`arrayMove`), the keyboard step, and the lifted copy gpui draws at the pointer.
//! The state lives in one [`Hub`] kept in the list's window state; handlers borrow it briefly
//! and call the product's callback only after the borrow ends.
use std::cell::RefCell;
use std::collections::HashMap;
use std::rc::Rc;

use gpui::{
    AnyElement, App, Bounds, Context, ElementId, IntoElement, ParentElement as _, Pixels, Point,
    Render, SharedString, Styled as _, Window, canvas, div,
};

use super::SortableCardItem;
use super::row;
use crate::tokens::{Color, Length, Shadow};
use crate::ui::context::Ds;
use crate::ui::convert;

pub(super) type OnReorder = Rc<dyn Fn(Vec<SharedString>, &mut Window, &mut App)>;

/// The payload of a gpui drag: the list it belongs to and the card's id.
pub(super) struct Drag {
    pub list: ElementId,
    pub id: SharedString,
}

#[derive(Default)]
pub(super) struct Session {
    /// The card being dragged, and the row it would take the place of.
    pub active: Option<SharedString>,
    pub over: Option<SharedString>,
    /// Row boxes as last painted.
    pub rows: HashMap<SharedString, Bounds<Pixels>>,
    /// Card ids in list order, and what to call with the new order.
    pub order: Vec<SharedString>,
    pub on_reorder: Option<OnReorder>,
}

pub(super) type Hub = Rc<RefCell<Session>>;

impl Session {
    /// Where the drop indicator goes: the row it sits at and whether it is after it (the
    /// dragged card moves down past it) or before it.
    pub(super) fn indicator(&self) -> Option<(&SharedString, bool)> {
        let (active, over) = (self.active.as_ref()?, self.over.as_ref()?);
        let at = |id: &SharedString| self.order.iter().position(|other| other == id);
        if active == over {
            return None;
        }
        Some((over, at(active)? < at(over)?))
    }
}

/// Records the box of row `id` as it paints (absolutely, filling the row).
pub(super) fn recorder(hub: &Hub, id: &SharedString) -> AnyElement {
    let (hub, id) = (hub.clone(), id.clone());
    canvas(
        |bounds: Bounds<Pixels>, _, _| bounds,
        move |_, bounds, _, _| {
            hub.borrow_mut().rows.insert(id, bounds);
        },
    )
    .absolute()
    .top_0()
    .left_0()
    .size_full()
    .into_any_element()
}

/// The row whose centre is nearest the pointer (`closestCenter`).
pub(super) fn pointer_update(hub: &Hub, y: f32) {
    let mut session = hub.borrow_mut();
    let distance =
        |bounds: &Bounds<Pixels>| (f32::from(bounds.origin.y + bounds.size.height / 2.) - y).abs();
    let nearest = session
        .rows
        .iter()
        .min_by(|a, b| distance(a.1).total_cmp(&distance(b.1)))
        .map(|(id, _)| id.clone());
    session.over = nearest;
}

/// `arrayMove`.
fn array_move(order: &[SharedString], from: usize, to: usize) -> Vec<SharedString> {
    let mut next = order.to_vec();
    let card = next.remove(from);
    next.insert(to, card);
    next
}

/// A drag ended: on a drop, the dragged card takes the place of the row it is over.
pub(super) fn finish(hub: &Hub, drop: bool, window: &mut Window, cx: &mut App) {
    let (moved, on_reorder) = {
        let mut session = hub.borrow_mut();
        let (active, over) = (session.active.take(), session.over.take());
        let at = |id: &SharedString| session.order.iter().position(|other| other == id);
        let moved = active
            .zip(over)
            .filter(|_| drop)
            .and_then(|(active, over)| Some((at(&active)?, at(&over)?)))
            .filter(|(from, to)| from != to)
            .map(|(from, to)| array_move(&session.order, from, to));
        (moved, session.on_reorder.clone())
    };
    if let (Some(order), Some(on_reorder)) = (moved, on_reorder) {
        on_reorder(order, window, cx);
    }
}

/// The keyboard moves card `id` one place up or down.
pub(super) fn step(hub: &Hub, id: &SharedString, up: bool, window: &mut Window, cx: &mut App) {
    let (moved, on_reorder) = {
        let session = hub.borrow();
        let moved = session
            .order
            .iter()
            .position(|other| other == id)
            .and_then(|from| {
                let to = if up { from.checked_sub(1)? } else { from + 1 };
                (to < session.order.len()).then(|| array_move(&session.order, from, to))
            });
        (moved, session.on_reorder.clone())
    };
    if let (Some(order), Some(on_reorder)) = (moved, on_reorder) {
        on_reorder(order, window, cx);
    }
}

/// The lifted copy (`.overlay`): the dragged card at the row's width on the opaque raised
/// surface with the drag shadow, kept over the grip it was picked up by. Not reproduced: the
/// `--motion-scale-lift` scale.
pub(super) struct Lifted {
    pub item: SortableCardItem,
    pub width: Option<Pixels>,
    /// Where the grip sits in the card: the view is drawn at the grip's origin.
    pub shift: Point<Pixels>,
}

impl Render for Lifted {
    fn render(&mut self, _: &mut gpui::Window, cx: &mut Context<Self>) -> impl IntoElement {
        let (radius, fill, shadow, card) = {
            let ds = Ds::get(cx);
            (
                ds.len(Length::RadiusPanel),
                ds.color(Color::ColorSurfaceRaisedOpaque),
                convert::box_shadows(ds.tokens().shadow(Shadow::ShadowDragLift), ds.tokens()),
                row::card(&self.item, row::static_grip(ds), None, ds),
            )
        };
        let mut surface = div().rounded(radius).bg(fill).shadow(shadow).child(card);
        if let Some(width) = self.width {
            surface = surface.w(width);
        }
        div()
            .relative()
            .left(-self.shift.x)
            .top(-self.shift.y)
            .child(surface)
    }
}
