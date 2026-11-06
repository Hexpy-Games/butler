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
    LayoutId, ParentElement as _, Pixels, Styled as _, Window, div,
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
    /// The container is a grid whose column is sized by its items (an `auto` track).
    auto_track: bool,
    dialog: Option<DialogFrame>,
}

/// What a Dialog tells its header, footer and title (the CSS reads it from the parent's
/// `data-layout` and `--dialog-close-room`).
#[derive(Clone, Copy, Debug)]
pub struct DialogFrame {
    /// `layout="scroll-body"`: the header and footer carry the padding that replaces the gap.
    pub scroll_body: bool,
    /// How far the close button reaches into the content box (`--dialog-close-room`, 0 without it).
    pub close_room: f32,
    /// Inside a DialogHeader, which insets its own end.
    pub in_header: bool,
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

/// Whether the container being laid out is a grid whose column is sized by its items. A
/// percentage `min-width` of an item there resolves against the column the item itself sizes
/// (cyclic), so it adds nothing.
pub fn auto_track(cx: &App) -> bool {
    cx.try_global::<Scopes>()
        .and_then(|scopes| scopes.0.last().copied())
        .is_some_and(|frame| frame.auto_track)
}

/// An item with `width: max-content` in a container that stretches its items: a full-width row
/// that holds `child` at its content width. gpui has no `justify-self`, which is what a grid
/// item needs to opt out of the stretch (`align-self` is the other axis there).
pub fn max_content(child: impl IntoElement) -> AnyElement {
    div()
        .flex()
        .w_full()
        .min_w_0()
        .child(div().flex().flex_none().max_w_full().child(child))
        .into_any_element()
}

/// The Dialog being laid out, when the container is inside one.
pub fn dialog(cx: &App) -> Option<DialogFrame> {
    cx.try_global::<Scopes>()
        .and_then(|scopes| scopes.0.last().copied())
        .and_then(|frame| frame.dialog)
}

/// `child` laid out in a Dialog's grid (its items stretch), or in one of its parts.
pub fn dialog_scope(frame: DialogFrame, child: impl IntoElement) -> Scope {
    framed(
        Frame {
            block: false,
            shrink_wrap: true,
            auto_track: false,
            dialog: Some(frame),
        },
        child,
    )
}

/// `child` laid out inside a block (`true`) or flex-like (`false`) container.
pub fn scope(block: bool, child: impl IntoElement) -> Scope {
    framed(
        Frame {
            block,
            shrink_wrap: false,
            auto_track: false,
            dialog: None,
        },
        child,
    )
}

/// `child` laid out as the item of a one-column grid with an `auto` track (a story canvas).
pub fn grid_scope(child: impl IntoElement) -> Scope {
    framed(
        Frame {
            block: false,
            shrink_wrap: true,
            auto_track: true,
            dialog: None,
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
            auto_track: false,
            dialog: None,
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
        let mut frame = self.frame;
        // A container inside a Dialog's part still sees the dialog it is in.
        frame.dialog = frame.dialog.or_else(|| dialog(cx));
        cx.default_global::<Scopes>().0.push(frame);
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
