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
use super::context::Ds;
use super::typo::Role;
use gpui::{
    AnyElement, App, Bounds, Element, ElementId, GlobalElementId, InspectorElementId, IntoElement,
    LayoutId, Pixels, Window,
};

/// The strut of a block container: the root's body font at its line height. An inline `Typo`
/// flowing in the container takes line boxes at least this tall.
pub fn container<E: gpui::Styled>(el: E, ds: &Ds) -> E {
    let body = Role::Body.tokens();
    let mut el = el.font_family(ds.body_font().clone());
    if let Some(body) = body {
        el = el
            .text_size(ds.len(body.size))
            .line_height(ds.len(body.line_height));
    }
    el
}

/// One container being laid out: whether it is a block (inline children get a strut) and whether
/// it is a column that stretches its items (an item with `width: max-content` must not stretch).
#[derive(Clone, Copy)]
struct Frame {
    block: bool,
    shrink_wrap: bool,
}

#[derive(Default)]
struct Scopes(Vec<Frame>);

impl gpui::Global for Scopes {}

/// Whether the container being laid out gives its inline children a strut.
pub fn active(cx: &App) -> bool {
    cx.try_global::<Scopes>()
        .and_then(|scopes| scopes.0.last().copied())
        .is_some_and(|frame| frame.block)
}

/// Whether the container being laid out is a column that stretches its items, so a control
/// with `width: max-content` has to opt out of the stretch.
pub fn shrink_wrap(cx: &App) -> bool {
    cx.try_global::<Scopes>()
        .and_then(|scopes| scopes.0.last().copied())
        .is_some_and(|frame| frame.shrink_wrap)
}

/// `child` laid out inside a block (`true`) or flex-like (`false`) container.
pub fn scope(block: bool, child: impl IntoElement) -> Scope {
    framed(
        Frame {
            block,
            shrink_wrap: false,
        },
        child,
    )
}

/// `child` laid out in a flex container; `stretch_column` when it is a column whose items stretch.
pub fn flex_scope(stretch_column: bool, child: impl IntoElement) -> Scope {
    framed(
        Frame {
            block: false,
            shrink_wrap: stretch_column,
        },
        child,
    )
}

fn framed(frame: Frame, child: impl IntoElement) -> Scope {
    Scope {
        frame,
        child: Some(child.into_any_element()),
    }
}

pub struct Scope {
    frame: Frame,
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
        cx.default_global::<Scopes>().0.push(self.frame);
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
