//! CSS `overflow: clip` with `overflow-clip-margin`: the child paints (and is hit) only inside
//! its own box grown by `margin` on each edge (a negative margin cuts into the box). Paint only:
//! the child's layout passes through untouched, so the room never moves a sibling or a parent.
use gpui::{
    AnyElement, App, Bounds, ContentMask, Edges, Element, ElementId, GlobalElementId,
    InspectorElementId, IntoElement, LayoutId, Pixels, Window, point, px, size,
};

pub(super) struct ClipMargin {
    child: AnyElement,
    margin: Edges<Pixels>,
}

impl ClipMargin {
    pub(super) fn new(child: AnyElement, margin: Edges<Pixels>) -> Self {
        Self { child, margin }
    }

    fn mask(&self, bounds: Bounds<Pixels>) -> ContentMask<Pixels> {
        let m = &self.margin;
        ContentMask {
            bounds: Bounds::new(
                bounds.origin - point(m.left, m.top),
                size(
                    (bounds.size.width + m.left + m.right).max(px(0.)),
                    (bounds.size.height + m.top + m.bottom).max(px(0.)),
                ),
            ),
            fade_out: Edges::default(),
            ..ContentMask::default()
        }
    }
}

impl IntoElement for ClipMargin {
    type Element = Self;

    fn into_element(self) -> Self {
        self
    }
}

impl Element for ClipMargin {
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
        window.with_content_mask(Some(mask), |window| self.child.prepaint(window, cx));
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
