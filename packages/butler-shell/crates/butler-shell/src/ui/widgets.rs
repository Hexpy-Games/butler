//! The screenshot harness's geometry selector.
use gpui::{AnyElement, InteractiveElement, IntoElement};

/// Stable geometry selector for the screenshot harness, on an element that is a layout box
/// anyway (it carries its own styles). `anchor(div(), name).child(x)` adds a plain block around
/// `x`; name a lone child with [`anchored`] instead.
pub(crate) fn anchor<E: InteractiveElement>(el: E, name: &str) -> E {
    #[cfg(feature = "shots")]
    {
        el.debug_selector(|| name.to_owned())
    }
    #[cfg(not(feature = "shots"))]
    {
        let _ = name;
        el
    }
}

/// `child` named for the harness without a layout box of its own: the selector reports the
/// child's bounds, and the child is laid out as if the caller had put it there directly.
pub(crate) fn anchored(child: impl IntoElement, name: &str) -> AnyElement {
    #[cfg(feature = "shots")]
    {
        probe::Anchored::new(child.into_any_element(), name).into_any_element()
    }
    #[cfg(not(feature = "shots"))]
    {
        let _ = name;
        child.into_any_element()
    }
}

/// [`anchor`] for a control: `<name>` while it takes clicks, `<name>-disabled` while it does not
/// (Electron's `:not(:disabled)`), so a harness step waits until the control is usable.
pub(crate) fn control_anchor<E: InteractiveElement>(el: E, name: &str, enabled: bool) -> E {
    #[cfg(feature = "shots")]
    {
        if enabled {
            anchor(el, name)
        } else {
            anchor(el, &format!("{name}-disabled"))
        }
    }
    #[cfg(not(feature = "shots"))]
    {
        let _ = (name, enabled);
        el
    }
}

#[cfg(feature = "shots")]
mod probe {
    use gpui::{
        AnyElement, App, Bounds, Div, Element, ElementId, GlobalElementId, Hitbox,
        InspectorElementId, InteractiveElement as _, IntoElement, LayoutId, Pixels, Styled as _,
        Window, div,
    };

    type Frame = <Div as Element>::RequestLayoutState;

    /// Passes the child's layout through untouched (its layout id is the element's own) and
    /// paints an empty, box-less `div` carrying the debug selector into the child's bounds. The
    /// probe's own layout node is never attached to the tree, so it takes no room.
    pub(super) struct Anchored {
        child: AnyElement,
        probe: Div,
    }

    impl Anchored {
        pub(super) fn new(child: AnyElement, name: &str) -> Self {
            let name = name.to_owned();
            Self {
                child,
                // `flex`: a block `div` would join the paragraph machinery of a block parent.
                probe: div().flex().debug_selector(move || name),
            }
        }
    }

    impl IntoElement for Anchored {
        type Element = Self;

        fn into_element(self) -> Self {
            self
        }
    }

    impl Element for Anchored {
        type RequestLayoutState = Frame;
        type PrepaintState = Option<Hitbox>;

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
        ) -> (LayoutId, Frame) {
            let (_, frame) = self.probe.request_layout(None, None, window, cx);
            (self.child.request_layout(window, cx), frame)
        }

        fn prepaint(
            &mut self,
            _: Option<&GlobalElementId>,
            _: Option<&InspectorElementId>,
            bounds: Bounds<Pixels>,
            frame: &mut Frame,
            window: &mut Window,
            cx: &mut App,
        ) -> Option<Hitbox> {
            self.child.prepaint(window, cx);
            self.probe.prepaint(None, None, bounds, frame, window, cx)
        }

        fn paint(
            &mut self,
            _: Option<&GlobalElementId>,
            _: Option<&InspectorElementId>,
            bounds: Bounds<Pixels>,
            frame: &mut Frame,
            hitbox: &mut Option<Hitbox>,
            window: &mut Window,
            cx: &mut App,
        ) {
            self.child.paint(window, cx);
            self.probe
                .paint(None, None, bounds, frame, hitbox, window, cx);
        }
    }
}
