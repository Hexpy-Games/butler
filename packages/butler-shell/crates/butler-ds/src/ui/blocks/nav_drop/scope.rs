//! NavDropScope (`NavDropScope` in NavDropTarget.tsx): wraps a droppable tree, a column with the
//! sidebar row spacing. It sizes the insert slot (one row; none for an outside payload or under
//! reduced motion), moves the rows after the insertion point (anywhere in its tree, see
//! `member.rs`), and, once [`NavDropScope::drag`] gives it the rules, runs the hit-testing of a
//! gpui drag: every move of a drag of payload `T` over the scope resolves a row and zone, and a
//! drop commits it if the product's `can_drop` allows. The product turns the committed hit into
//! its own move. A move draws again only when what it shows changes (the hit, a combine dwell,
//! the auto-scroll band), as React renders only when the hit's `data-drop` changes, and then only
//! the view the scope renders in: the other views keep their cached frames.
use std::cell::{Cell, RefCell};
use std::collections::HashMap;
use std::rc::Rc;
use std::time::Instant;

use gpui::{
    AnyElement, App, AppContext as _, DragMoveEvent, ElementId, EntityId, InteractiveElement as _,
    IntoElement, ParentElement as _, RenderOnce, ScrollHandle, SharedString, Stateful, Styled as _,
    Window, div,
};

use super::auto_scroll::{self, Edge};
use super::member::{Frame, Framed, Placed};
use super::overlay::scroll_band;
use super::row::{Boxes, Slot};
use super::zones::{
    DropZone, DropZoneBox, DropZoneCandidate, DropZoneHit, DropZoneRules, DropZoneTracker,
};
use super::{NavDropPosition, NavDropTarget, Payload};
use crate::tokens::{Density, Length};
use crate::ui::blocks::nav_row::metrics::{density_of, metrics};
use crate::ui::context::Ds;

pub(super) type Hit = DropZoneHit<SharedString>;
type Drive =
    Box<dyn FnOnce(Stateful<gpui::Div>, Rc<Shared>, Option<ScrollHandle>) -> Stateful<gpui::Div>>;
type Zones<T> = Rc<dyn Fn(&T, &str) -> Option<DropZoneRules>>;
type CanDrop<T> = Rc<dyn Fn(&T, &Hit) -> bool>;
type OnDrop<T> = Rc<dyn Fn(&T, Hit, &mut Window, &mut App)>;

/// What the product tells the scope about a drag of payload `T`.
pub struct DragRules<T> {
    /// Which zones a row takes for this payload (`None`: the row takes no drop, such as the
    /// dragged row itself): the rules of `app/space/drag.ts`.
    pub rules: Zones<T>,
    /// The last check of a hit, as gpui's `can_drop`: the whole drop rule (is this folder
    /// open to this payload, may it nest here), made again when the pointer is released.
    pub can_drop: CanDrop<T>,
    /// Called with the committed hit when the payload is dropped.
    pub on_drop: OnDrop<T>,
}

/// The drag state a scope keeps between frames.
#[derive(Default)]
pub(super) struct Shared {
    pub(super) boxes: Boxes,
    /// The rows the last layout placed, each with its header inside its item, in px from the
    /// item's top and its height (`NavDropTarget::indicator`): the box the drop zones are tested
    /// on, as React measures the `tree-row` header and not the whole item, which an open folder
    /// stretches over its children. A row a fold took away is no longer here.
    pub(super) headers: RefCell<HashMap<SharedString, Option<(f32, f32)>>>,
    tracker: RefCell<DropZoneTracker<SharedString>>,
    /// A drag of the scope's payload type has moved over it.
    engaged: Cell<bool>,
    pointer_y: Cell<Option<f32>>,
    edge: Cell<Option<Edge>>,
    /// The view the scope renders in: the one a changed hit draws again.
    view: Cell<Option<EntityId>>,
}

impl Shared {
    /// What a pointer move can change on screen: the hit, a combine zone waiting out its dwell
    /// (polled each frame), and the pointer being in an auto-scroll edge band (which scrolls
    /// each frame).
    fn seen(&self, scroll: Option<&ScrollHandle>) -> (Option<Hit>, bool, bool) {
        let band = scroll.zip(self.pointer_y.get()).is_some_and(|(handle, y)| {
            let bounds = handle.bounds();
            let (top, bottom) = (bounds.top().as_f32(), bounds.bottom().as_f32());
            auto_scroll::step(y, top, bottom, auto_scroll::EDGE) != 0.
        });
        let tracker = self.tracker.borrow();
        (tracker.current().cloned(), tracker.waiting(), band)
    }

    /// Draws the scope's view again, and only it.
    fn repaint(&self, cx: &mut App) {
        if let Some(view) = self.view.get() {
            cx.notify(view);
        }
    }
}

enum Entry {
    Row(NavDropTarget),
    Other(AnyElement),
}

#[derive(IntoElement)]
pub struct NavDropScope {
    id: ElementId,
    active: Option<bool>,
    payload: Payload,
    edge: Option<Edge>,
    scroll: Option<ScrollHandle>,
    combine_as: NavDropPosition,
    drive: Option<Drive>,
    entries: Vec<Entry>,
}

impl NavDropScope {
    pub fn new(id: impl Into<ElementId>) -> Self {
        Self {
            id: id.into(),
            active: None,
            payload: Payload::Rows,
            edge: None,
            scroll: None,
            combine_as: NavDropPosition::Group,
            drive: None,
            entries: Vec::new(),
        }
    }

    /// A drag is in progress over this tree: rows may move to open a slot. A scope that drives
    /// its drag knows this itself.
    pub fn active(mut self, active: bool) -> Self {
        self.active = Some(active);
        self
    }

    /// `Outside`: the drag carries something from outside the tree; rows never move or open a slot.
    pub fn payload(mut self, payload: Payload) -> Self {
        self.payload = payload;
        self
    }

    /// The list is auto-scrolling at this edge: a band with a chevron there. Without a
    /// driver the product reports it; a driven scope sets it from its own scrolling.
    pub fn auto_scroll(mut self, edge: Option<Edge>) -> Self {
        self.edge = edge;
        self
    }

    /// The list's scroll handle: a drag within 40px of its edge scrolls it each frame.
    pub fn scroll(mut self, handle: ScrollHandle) -> Self {
        self.scroll = Some(handle);
        self
    }

    /// What a `Combine` zone is drawn as: a group ring, or a drop-inside ring.
    pub fn combine_as(mut self, position: NavDropPosition) -> Self {
        self.combine_as = position;
        self
    }

    /// A row of the tree.
    pub fn row(mut self, row: NavDropTarget) -> Self {
        self.entries.push(Entry::Row(row));
        self
    }

    /// Something that is no row (the root zone, a "load more" row); it slides with the rows.
    pub fn other(mut self, element: impl IntoElement) -> Self {
        self.entries.push(Entry::Other(element.into_any_element()));
        self
    }

    /// Drives a drag of payload `T` with `rules`.
    pub fn drag<T: 'static>(mut self, rules: DragRules<T>) -> Self {
        self.drive = Some(Box::new(move |el, shared, scroll| {
            drive::<T>(el, (shared, scroll), rules)
        }));
        self
    }
}

/// Wires the gpui drag handlers of payload `T` onto the scope's element.
fn drive<T: 'static>(
    el: Stateful<gpui::Div>,
    (shared, scroll): (Rc<Shared>, Option<ScrollHandle>),
    rules: DragRules<T>,
) -> Stateful<gpui::Div> {
    let (moving, dropping) = (shared.clone(), shared);
    let (zones, check, commit) = (rules.rules, rules.can_drop, rules.on_drop);
    let check_drop = check.clone();
    el.on_drag_move::<T>(move |event: &DragMoveEvent<T>, _, cx| {
        let seen = moving.seen(scroll.as_ref());
        if event.bounds.contains(&event.event.position) {
            let payload = event.drag(cx);
            let y = event.event.position.y.as_f32();
            let headers = moving.headers.borrow();
            let rows = moving
                .boxes
                .borrow()
                .iter()
                .filter_map(|(key, bounds)| {
                    let header = *headers.get(key)?;
                    let rules = zones(payload, key)?;
                    Some(DropZoneCandidate {
                        key: key.clone(),
                        bounds: header_box(*bounds, header),
                        rules,
                    })
                })
                .collect();
            drop(headers);
            moving.engaged.set(true);
            moving.pointer_y.set(Some(y));
            moving.tracker.borrow_mut().update(y, rows, Instant::now());
        } else {
            moving.tracker.borrow_mut().reset();
            moving.pointer_y.set(None);
        }
        // Only the auto-scroll reads the pointer between hits: it runs on its own frames.
        if moving.seen(scroll.as_ref()) != seen {
            moving.repaint(cx);
        }
    })
    .on_drop::<T>(move |payload, window, cx| {
        let hit = dropping.tracker.borrow().current().cloned();
        dropping.tracker.borrow_mut().reset();
        dropping.engaged.set(false);
        dropping.pointer_y.set(None);
        dropping.edge.set(None);
        if let Some(hit) = hit.filter(|hit| check_drop(payload, hit)) {
            commit(payload, hit, window, cx);
        }
        dropping.repaint(cx);
    })
}

/// The box the zones are tested on: the row header (`measureDropBox(header, scope)`), or the
/// whole item when the row gave no header.
fn header_box(item: gpui::Bounds<gpui::Pixels>, header: Option<(f32, f32)>) -> DropZoneBox {
    match header.filter(|(_, height)| *height > 0.) {
        Some((top, height)) => DropZoneBox {
            top: item.top().as_f32() + top,
            height,
        },
        None => DropZoneBox {
            top: item.top().as_f32(),
            height: item.size.height.as_f32(),
        },
    }
}

/// One nav row's height at the scope's density.
pub(super) fn row_height(cx: &App) -> f32 {
    let ds = Ds::get(cx);
    metrics(ds, density_of(ds, None::<Density>, cx)).height
}

/// The slot (`--nav-drop-gap`, `--nav-drop-spacing`) at the scope's density.
fn slot(payload: Payload, cx: &App) -> Slot {
    let ds = Ds::get(cx);
    let height = row_height(cx);
    let spacing = f32::from(ds.len(Length::SpaceXs));
    let gap = if payload == Payload::Outside || ds.reduced_motion() {
        0.
    } else {
        height + spacing
    };
    Slot { gap, spacing }
}

/// The position a zone is drawn as.
pub(super) fn position(zone: DropZone, combine: NavDropPosition) -> NavDropPosition {
    match zone {
        DropZone::Before => NavDropPosition::Before,
        DropZone::After => NavDropPosition::After,
        DropZone::Combine => combine,
    }
}

/// One frame of the drag the scope drives: forgets a drag that ended outside the scope, lets a
/// combine dwell commit without a further move (as the React timer does), and scrolls the list
/// when the pointer is in its edge band. Returns the edge that scrolled, if any.
fn advance(
    shared: &Shared,
    scroll: Option<&ScrollHandle>,
    window: &mut Window,
    cx: &mut App,
) -> Option<Edge> {
    let dragging = cx.has_active_drag();
    if !dragging && shared.engaged.get() {
        shared.engaged.set(false);
        shared.tracker.borrow_mut().reset();
        shared.pointer_y.set(None);
    }
    if shared.tracker.borrow().waiting() {
        shared.tracker.borrow_mut().poll(Instant::now());
        crate::ui::motion::input_frame(window);
    }
    let (Some(handle), Some(y)) = (scroll, shared.pointer_y.get()) else {
        return None;
    };
    if !dragging {
        return None;
    }
    let edge = auto_scroll::tick(handle, handle.bounds(), y);
    shared.edge.set(edge);
    if edge.is_some() {
        crate::ui::motion::input_frame(window);
    }
    edge
}

impl RenderOnce for NavDropScope {
    fn render(mut self, window: &mut Window, cx: &mut App) -> impl IntoElement {
        let shared = window
            .use_keyed_state((self.id.clone(), "drop"), cx, |_, _| {
                Rc::new(Shared::default())
            })
            .read(cx)
            .clone();
        shared.view.set(Some(window.current_view()));
        let active = self.active.unwrap_or_else(|| cx.has_active_drag());
        let edge = advance(&shared, self.scroll.as_ref(), window, cx);
        let band = edge.or(self.edge).filter(|_| active);
        let hit = shared.tracker.borrow().current().cloned();
        let list = {
            let headers = shared.headers.borrow();
            shared
                .boxes
                .borrow()
                .iter()
                .filter(|(key, _)| headers.contains_key(*key))
                .map(|(_, bounds)| *bounds)
                .reduce(|a, b| a.union(&b))
        };
        // The rows register again as the tree lays out.
        shared.headers.borrow_mut().clear();
        let frame = Frame::new(
            self.id.clone(),
            shared.clone(),
            (slot(self.payload, cx), self.combine_as),
            hit,
        );
        let children: Vec<Placed> = std::mem::take(&mut self.entries)
            .into_iter()
            .enumerate()
            .map(|(index, entry)| match entry {
                Entry::Row(target) => Placed::row(target),
                Entry::Other(element) => {
                    Placed::other((self.id.clone(), format!("other-{index}")).into(), element)
                }
            })
            .collect();
        let ds = Ds::get(cx);
        let band = band
            .zip(self.scroll.as_ref().map(ScrollHandle::bounds).or(list))
            .map(|(edge, bounds)| scroll_band(edge, bounds, ds));
        let clip = active.then(|| ds.len(Length::DropClipMargin)); // DS: NavDropTarget.module.css:15
        let mut root = div()
            .id((self.id, "scope"))
            .flex()
            .flex_col()
            .gap(ds.len(Length::SpaceXs))
            .children(children)
            .children(band);
        if let Some(drive) = self.drive {
            root = drive(root, shared, self.scroll);
        }
        Framed::new(frame, clip, root)
    }
}
