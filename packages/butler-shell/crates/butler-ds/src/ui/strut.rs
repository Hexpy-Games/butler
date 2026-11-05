//! The inline strut. In CSS a block container's line boxes are at least as tall as the
//! container's own line height (the strut: its font at its line height), so an inline-level
//! `Typo` (a span: Caption, Text, titles, ...) inside a block takes the taller of its own line
//! and the strut, with baselines aligned. Flex and grid containers blockify their items, which
//! have no strut.
//!
//! The block containers of the DS (Box, Card, TintedGlass, item wrappers) wrap their subtree in
//! [`scope`] with `true` and Stack with `false`; an inline `Typo` reads [`active`] while it
//! renders. The strut is the root's body line (`--typo-body-*`), which every DS container
//! inherits unless an ancestor sets another.
use gpui::{
    AnyElement, App, Bounds, Element, ElementId, GlobalElementId, InspectorElementId, IntoElement,
    LayoutId, Pixels, Window,
};

#[derive(Default)]
struct Scopes(Vec<bool>);

impl gpui::Global for Scopes {}

/// Whether the container being laid out gives its inline children a strut.
pub fn active(cx: &App) -> bool {
    cx.try_global::<Scopes>()
        .and_then(|scopes| scopes.0.last().copied())
        .unwrap_or(false)
}

/// `child` laid out inside a block (`true`) or flex-like (`false`) container.
pub fn scope(block: bool, child: impl IntoElement) -> Scope {
    Scope {
        block,
        child: Some(child.into_any_element()),
    }
}

pub struct Scope {
    block: bool,
    child: Option<AnyElement>,
}

impl IntoElement for Scope {
    type Element = Self;

    fn into_element(self) -> Self {
        self
    }
}

impl Element for Scope {
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
        cx.default_global::<Scopes>().0.push(self.block);
        let layout = child.request_layout(window, cx);
        cx.default_global::<Scopes>().0.pop();
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
        &mut (): &mut (),
        window: &mut Window,
        cx: &mut App,
    ) {
        child.paint(window, cx);
    }
}
