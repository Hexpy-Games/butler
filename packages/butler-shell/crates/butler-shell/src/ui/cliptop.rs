//! Clips a subtree above a window-space y: the SidebarShell `clip-path` that hides rows under
//! the stuck browse header (gpui has neither `position: sticky` nor clip-path).
use gpui::{
    AnyElement, App, Bounds, ContentMask, Element, ElementId, GlobalElementId, InspectorElementId,
    IntoElement, LayoutId, Pixels, Window, point, px,
};

pub(crate) struct ClipTop {
    child: AnyElement,
    clip_y: Option<Pixels>,
}

pub(crate) fn clip_top(child: impl IntoElement, clip_y: Option<Pixels>) -> ClipTop {
    ClipTop {
        child: child.into_any_element(),
        clip_y,
    }
}

impl IntoElement for ClipTop {
    type Element = Self;
    fn into_element(self) -> Self {
        self
    }
}

impl Element for ClipTop {
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
        _: Bounds<Pixels>,
        (): &mut (),
        window: &mut Window,
        cx: &mut App,
    ) {
        self.child.prepaint(window, cx);
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
        match self.clip_y {
            Some(y) => {
                let mask = ContentMask {
                    bounds: Bounds::from_corners(
                        point(bounds.left() - px(8.), y),
                        point(bounds.right() + px(8.), bounds.bottom().max(y)),
                    ),
                    ..Default::default()
                };
                window.with_content_mask(Some(mask), |window| self.child.paint(window, cx));
            }
            None => self.child.paint(window, cx),
        }
    }
}
