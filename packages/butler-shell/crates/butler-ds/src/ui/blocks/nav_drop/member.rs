//! The rows and neighbours of a NavDropScope's tree, at any depth (the CSS reaches every
//! `collapsible-list-item` under the scope with `:has()` and `~`). The scope's frame is in
//! effect while its tree lays out, so a row in a nested list (a folder's children, which its
//! list renders) reads the hit and the slot where it renders. The tree lays out in order: once
//! the row with a `before` or `after` drop has laid out, every later row and neighbour travels
//! down by the gap, except inside one that travels already (its content rides along). So the
//! rows after the insertion point in its list, and the rows after each enclosing folder, move.
use std::cell::Cell;
use std::rc::Rc;

use gpui::{
    AnyElement, App, Bounds, Element, ElementId, GlobalElementId, InspectorElementId, IntoElement,
    LayoutId, ParentElement as _, Pixels, Styled as _, Window, div,
};

use super::row::{self, Boxes, Ctx, Slot};
use super::scope::{Hit, Shared, position, row_height};
use super::{NavDropPosition, NavDropTarget};
use crate::ui::collapsible;

/// What a scope tells the rows of its tree while the tree lays out.
pub(super) struct Frame {
    scope: ElementId,
    shared: Rc<Shared>,
    slot: Slot,
    combine_as: NavDropPosition,
    hit: Option<Hit>,
    /// The slot has opened above: what lays out from here on travels.
    moved: Cell<bool>,
    /// How many travelling rows and neighbours enclose the one laying out.
    carried: Cell<usize>,
}

impl Frame {
    pub(super) fn new(
        scope: ElementId,
        shared: Rc<Shared>,
        (slot, combine_as): (Slot, NavDropPosition),
        hit: Option<Hit>,
    ) -> Self {
        Self {
            scope,
            shared,
            slot,
            combine_as,
            hit,
            moved: Cell::new(false),
            carried: Cell::new(0),
        }
    }
}

/// The frames of the scopes around the layout in progress, innermost last.
#[derive(Default)]
struct Frames(Vec<Rc<Frame>>);

impl gpui::Global for Frames {}

/// A scope's tree laid out with its frame in effect and, while a drag is active, with the folds
/// in it painting the drop room past their box (`--collapsible-clip-margin`).
pub(super) struct Framed {
    frame: Rc<Frame>,
    clip: Option<Pixels>,
    child: Option<AnyElement>,
}

impl Framed {
    pub(super) fn new(frame: Frame, clip: Option<Pixels>, child: impl IntoElement) -> Self {
        Self {
            frame: Rc::new(frame),
            clip,
            child: Some(child.into_any_element()),
        }
    }
}

impl IntoElement for Framed {
    type Element = Self;

    fn into_element(self) -> Self {
        self
    }
}

impl Element for Framed {
    type RequestLayoutState = AnyElement;
    type PrepaintState = ();

    fn id(&self) -> Option<ElementId> {
        None
    }

    fn source_location(&self) -> Option<&'static core::panic::Location<'static>> {
        None
    }

    fn request_layout(
        &mut self,
        _: Option<&GlobalElementId>,
        _: Option<&InspectorElementId>,
        window: &mut Window,
        cx: &mut App,
    ) -> (LayoutId, AnyElement) {
        let mut child = self
            .child
            .take()
            .unwrap_or_else(|| gpui::Empty.into_any_element());
        cx.default_global::<Frames>().0.push(self.frame.clone());
        let layout = collapsible::with_clip_margin(self.clip, window, cx, |window, cx| {
            child.request_layout(window, cx)
        });
        cx.default_global::<Frames>().0.pop();
        (layout, child)
    }

    fn prepaint(
        &mut self,
        _: Option<&GlobalElementId>,
        _: Option<&InspectorElementId>,
        _: Bounds<Pixels>,
        child: &mut AnyElement,
        window: &mut Window,
        cx: &mut App,
    ) {
        child.prepaint(window, cx);
    }

    fn paint(
        &mut self,
        _: Option<&GlobalElementId>,
        _: Option<&InspectorElementId>,
        _: Bounds<Pixels>,
        child: &mut AnyElement,
        (): &mut (),
        window: &mut Window,
        cx: &mut App,
    ) {
        child.paint(window, cx);
    }
}

enum What {
    Row(NavDropTarget),
    Other(ElementId, AnyElement),
}

/// A row or a neighbour, placed by the scope around it when it lays out.
pub struct Placed {
    what: Option<What>,
}

impl Placed {
    pub(super) fn row(target: NavDropTarget) -> Self {
        Self {
            what: Some(What::Row(target)),
        }
    }

    pub(super) fn other(id: ElementId, element: AnyElement) -> Self {
        Self {
            what: Some(What::Other(id, element)),
        }
    }
}

impl IntoElement for Placed {
    type Element = Self;

    fn into_element(self) -> Self {
        self
    }
}

/// The row in `frame`: it registers its header for the hit-testing, takes its drop from the
/// hit, and travels after the slot (or as a `before` target). Returns the element, whether it
/// travels, and whether the slot opens at it.
fn place_row(
    mut target: NavDropTarget,
    frame: &Frame,
    follows: bool,
    window: &mut Window,
    cx: &mut App,
) -> (AnyElement, bool, bool) {
    if target.row_header && target.indicator.is_none() {
        target.indicator = Some((0., row_height(cx)));
    }
    frame
        .shared
        .headers
        .borrow_mut()
        .insert(target.key.clone(), target.indicator);
    if target.drop.is_none() {
        let combine = target.combine_as.unwrap_or(frame.combine_as);
        target.drop = frame
            .hit
            .as_ref()
            .filter(|hit| hit.key == target.key)
            .map(|hit| position(hit.zone, combine));
    }
    let before = target.drop == Some(NavDropPosition::Before);
    let opens = before || target.drop == Some(NavDropPosition::After);
    let ctx = Ctx {
        scope: &frame.scope,
        slot: frame.slot,
        shift: follows,
        boxes: &frame.shared.boxes,
    };
    (
        row::render(target, &ctx, window, cx),
        follows || before,
        opens,
    )
}

/// A row outside any scope: drawn as it is, with no slot.
fn alone(what: What, window: &mut Window, cx: &mut App) -> AnyElement {
    match what {
        What::Row(target) => {
            let scope = ElementId::from("nav-drop");
            let ctx = Ctx {
                scope: &scope,
                slot: Slot {
                    gap: 0.,
                    spacing: 0.,
                },
                shift: false,
                boxes: &Boxes::default(),
            };
            row::render(target, &ctx, window, cx)
        }
        What::Other(_, element) => element,
    }
}

impl Element for Placed {
    type RequestLayoutState = AnyElement;
    type PrepaintState = ();

    fn id(&self) -> Option<ElementId> {
        None
    }

    fn source_location(&self) -> Option<&'static core::panic::Location<'static>> {
        None
    }

    fn request_layout(
        &mut self,
        _: Option<&GlobalElementId>,
        _: Option<&InspectorElementId>,
        window: &mut Window,
        cx: &mut App,
    ) -> (LayoutId, AnyElement) {
        let what = self.what.take().unwrap_or_else(|| {
            What::Other(ElementId::from("nav-drop"), gpui::Empty.into_any_element())
        });
        let frame = cx
            .try_global::<Frames>()
            .and_then(|frames| frames.0.last().cloned());
        let Some(frame) = frame else {
            let mut element = alone(what, window, cx);
            return (element.request_layout(window, cx), element);
        };
        let follows = frame.moved.get() && frame.carried.get() == 0;
        let (mut element, travels, opens) = match what {
            What::Row(target) => place_row(target, &frame, follows, window, cx),
            What::Other(id, element) => {
                let goal = if follows { frame.slot.gap } else { 0. };
                let el = row::slide(
                    &id,
                    goal,
                    div().flex().flex_col().child(element),
                    window,
                    cx,
                );
                (el.into_any_element(), follows, false)
            }
        };
        if travels {
            frame.carried.set(frame.carried.get() + 1);
        }
        let layout = element.request_layout(window, cx);
        if travels {
            frame.carried.set(frame.carried.get() - 1);
        }
        if opens {
            frame.moved.set(true);
        }
        (layout, element)
    }

    fn prepaint(
        &mut self,
        _: Option<&GlobalElementId>,
        _: Option<&InspectorElementId>,
        _: Bounds<Pixels>,
        element: &mut AnyElement,
        window: &mut Window,
        cx: &mut App,
    ) {
        element.prepaint(window, cx);
    }

    fn paint(
        &mut self,
        _: Option<&GlobalElementId>,
        _: Option<&InspectorElementId>,
        _: Bounds<Pixels>,
        element: &mut AnyElement,
        (): &mut (),
        window: &mut Window,
        cx: &mut App,
    ) {
        element.paint(window, cx);
    }
}
