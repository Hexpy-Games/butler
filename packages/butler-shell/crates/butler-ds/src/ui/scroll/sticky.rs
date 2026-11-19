//! CSS `position: sticky` with `top`, and the clip of the content a stuck box passes over.
//!
//! A [`Sticky`] box keeps its place in the layout; while its scroller has scrolled it past the
//! line `top` below the scrollport's top edge, it is drawn on that line, and it stops with its
//! containing block's bottom edge. gpui has no sticky positioning, and placing the box while
//! rendering reads the last frame's geometry: the box trails the scroll by a frame and the
//! remeasure frame that corrects it snaps it back, so it shakes on every scroll frame. [`Sticky`]
//! places it in prepaint instead, from geometry of the same frame, as Zed's sticky items are
//! placed: a scroller records its own bounds in its handle (`ScrollHandle::bounds`) and then
//! prepaints its children shifted by the live scroll offset (gpui `div.rs`,
//! `Interactivity::prepaint` → `clamp_scroll_position`), so the box's own bounds and the
//! scrollport's already hold this frame's scroll.
//!
//! [`ClipUnder`] clips the content after a stuck box at the box's bottom edge, with a content
//! mask (`useStickyClipping` + `clip-path: inset(...)`), not with layout margins.
use std::cell::Cell;
use std::rc::Rc;

use gpui::{
    AnyElement, App, Bounds, ContentMask, Div, Edges, Element, ElementId, GlobalElementId,
    InspectorElementId, InteractiveElement as _, IntoElement, LayoutId, Pixels, ScrollHandle,
    Window, point, px,
};

/// A box's bounds as prepaint placed it this frame, for elements prepainted after it to read.
/// Make one per render.
#[derive(Clone, Default)]
pub struct Placement(Rc<Cell<Option<Bounds<Pixels>>>>);

impl Placement {
    /// Records `block`'s bounds when it is prepainted, before its children.
    pub fn track(&self, mut block: Div) -> Div {
        let cell = self.0.clone();
        block
            .interactivity()
            .on_prepaint(move |prepaint, _, _| cell.set(Some(prepaint.bounds)));
        block
    }

    fn get(&self) -> Option<Bounds<Pixels>> {
        self.0.get()
    }
}

/// `child` with `position: sticky; top: <top>` in the scroller `scrollport` is the handle of.
pub struct Sticky {
    child: AnyElement,
    scrollport: ScrollHandle,
    top: Pixels,
    block: Option<Placement>,
    placed: Option<Placement>,
}

impl Sticky {
    pub fn new(scrollport: &ScrollHandle, top: Pixels, child: impl IntoElement) -> Self {
        Self {
            child: child.into_any_element(),
            scrollport: scrollport.clone(),
            top,
            block: None,
            placed: None,
        }
    }

    /// The containing block, tracked on an ancestor with [`Placement::track`]: the box stops at
    /// its bottom edge. Without one the box holds for as long as the scroller scrolls.
    pub fn within(mut self, block: &Placement) -> Self {
        self.block = Some(block.clone());
        self
    }

    /// Publishes where the box is drawn this frame (for [`ClipUnder`]).
    pub fn placed(mut self, placed: &Placement) -> Self {
        self.placed = Some(placed.clone());
        self
    }

    /// How far below its place in the layout (`bounds`, this frame's) the box is drawn.
    fn offset(&self, bounds: Bounds<Pixels>) -> Pixels {
        let line = self.scrollport.bounds().top() + self.top;
        let room = self
            .block
            .as_ref()
            .and_then(Placement::get)
            .map_or(Pixels::MAX, |block| block.bottom() - bounds.bottom());
        (line - bounds.top()).min(room).max(px(0.))
    }
}

impl IntoElement for Sticky {
    type Element = Self;

    fn into_element(self) -> Self {
        self
    }
}

impl Element for Sticky {
    type RequestLayoutState = ();
    type PrepaintState = ();

    fn id(&self) -> Option<ElementId> {
        None
    }

    fn source_location(&self) -> Option<&'static core::panic::Location<'static>> {
        None
    }

    /// The child's own layout: the box keeps its place.
    fn request_layout(
        &mut self,
        _: Option<&GlobalElementId>,
        _: Option<&InspectorElementId>,
        window: &mut Window,
        cx: &mut App,
    ) -> (LayoutId, ()) {
        (self.child.request_layout(window, cx), ())
    }

    fn prepaint(
        &mut self,
        _: Option<&GlobalElementId>,
        _: Option<&InspectorElementId>,
        bounds: Bounds<Pixels>,
        (): &mut (),
        window: &mut Window,
        cx: &mut App,
    ) {
        let offset = self.offset(bounds);
        if let Some(placed) = &self.placed {
            placed.0.set(Some(Bounds::new(
                point(bounds.origin.x, bounds.origin.y + offset),
                bounds.size,
            )));
        }
        window.with_element_offset(point(px(0.), offset), |window| {
            self.child.prepaint(window, cx);
        });
    }

    /// The child paints where prepaint placed it.
    fn paint(
        &mut self,
        _: Option<&GlobalElementId>,
        _: Option<&InspectorElementId>,
        _: Bounds<Pixels>,
        (): &mut (),
        (): &mut (),
        window: &mut Window,
        cx: &mut App,
    ) {
        self.child.paint(window, cx);
    }
}

/// `child` clipped at the bottom edge of the box `placed` publishes, so what scrolls under a
/// stuck box hides behind it; the other edges stay open by `outset` (the focus-ring room), the
/// bottom by [`ClipUnder::bottom`] when set: `clip-path: inset(var(--sticky-clip-top) -outset
/// -bottom)`.
pub struct ClipUnder {
    child: AnyElement,
    placed: Placement,
    outset: Pixels,
    bottom: Pixels,
}

impl ClipUnder {
    pub fn new(placed: &Placement, outset: Pixels, child: impl IntoElement) -> Self {
        Self {
            child: child.into_any_element(),
            placed: placed.clone(),
            outset,
            bottom: outset,
        }
    }

    /// How far the bottom edge stays open (the fold's clip margin while a drag moves rows).
    pub fn bottom(mut self, outset: Pixels) -> Self {
        self.bottom = outset;
        self
    }

    fn mask(&self, bounds: Bounds<Pixels>) -> ContentMask<Pixels> {
        let top = self.placed.get().map_or(bounds.top(), |placed| {
            placed.bottom().clamp(bounds.top(), bounds.bottom())
        });
        ContentMask {
            bounds: Bounds::from_corners(
                point(bounds.left() - self.outset, top),
                point(bounds.right() + self.outset, bounds.bottom() + self.bottom),
            ),
            fade_out: Edges::default(),
            ..ContentMask::default()
        }
    }
}

impl IntoElement for ClipUnder {
    type Element = Self;

    fn into_element(self) -> Self {
        self
    }
}

impl Element for ClipUnder {
    type RequestLayoutState = ();
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
    ) -> (LayoutId, ()) {
        (self.child.request_layout(window, cx), ())
    }

    /// Hitboxes take the mask too, so the rows under a stuck box do not take its clicks.
    fn prepaint(
        &mut self,
        _: Option<&GlobalElementId>,
        _: Option<&InspectorElementId>,
        bounds: Bounds<Pixels>,
        (): &mut (),
        window: &mut Window,
        cx: &mut App,
    ) {
        let mask = self.mask(bounds);
        window.with_content_mask(Some(mask), |window| {
            self.child.prepaint(window, cx);
        });
    }

    fn paint(
        &mut self,
        _: Option<&GlobalElementId>,
        _: Option<&InspectorElementId>,
        bounds: Bounds<Pixels>,
        (): &mut (),
        (): &mut (),
        window: &mut Window,
        cx: &mut App,
    ) {
        let mask = self.mask(bounds);
        window.with_content_mask(Some(mask), |window| self.child.paint(window, cx));
    }
}
