//! The popper: places a surface against a reference (the trigger or an anchor) in the top layer.
//! Radix Popper's job, done in the surface's own prepaint so the position is right on the frame
//! it first shows: the reference's bounds are written by [`Anchor::probe`] while the page
//! prepaints, which runs before the deferred layers prepaint. The resolved position is published
//! for the content (side, available size, transform origin) and, once a close starts, frozen
//! (card section 0.6): a surface that is closing keeps the position it had.
use std::cell::Cell;
use std::rc::Rc;

use gpui::{
    AnyElement, App, Bounds, Display, Element, ElementId, GlobalElementId, InspectorElementId,
    IntoElement, LayoutId, ParentElement as _, Pixels, Position, RenderOnce, Style, Styled as _,
    Window, canvas, deferred, div, point, px,
};

use super::place::{self, Options, Rect, Resolved};
use super::theme::Theme;
use crate::ui::context::Ds;
use crate::ui::layer::Z;

/// The reference rectangle a popper places against, measured in window pixels.
#[derive(Clone, Default)]
pub struct Anchor(Rc<Cell<Option<Bounds<Pixels>>>>);

impl Anchor {
    /// The reference as last measured.
    pub fn bounds(&self) -> Option<Bounds<Pixels>> {
        self.0.get()
    }

    pub(crate) fn cell(&self) -> Rc<Cell<Option<Bounds<Pixels>>>> {
        self.0.clone()
    }

    /// A zero-cost layer that measures the element it is placed in (its parent's box). Put it
    /// inside the trigger or anchor element.
    pub fn probe(&self) -> gpui::Div {
        let cell = self.0.clone();
        div().absolute().top_0().left_0().size_full().child(
            canvas(move |bounds, _, _| cell.set(Some(bounds)), |_, (), _, _| {})
                .absolute()
                .top_0()
                .left_0()
                .size_full(),
        )
    }
}

/// The resolved position, shared with the content that reads it on the next frame.
#[derive(Clone, Default)]
pub struct Output(Rc<Cell<Option<Resolved>>>);

impl Output {
    pub fn get(&self) -> Option<Resolved> {
        self.0.get()
    }

    /// Forgets the position (a new open measures afresh).
    pub fn clear(&self) {
        self.0.set(None);
    }
}

/// A surface placed against an [`Anchor`], drawn in the top layer at `z`.
#[derive(IntoElement)]
pub struct Popper {
    z: Z,
    pinned: bool,
    anchor: Anchor,
    options: Options,
    frozen: Option<Resolved>,
    output: Output,
    theme: Theme,
    child: AnyElement,
}

impl Popper {
    pub fn new(
        z: Z,
        anchor: &Anchor,
        options: Options,
        output: &Output,
        theme: Theme,
        child: impl IntoElement,
    ) -> Self {
        Self {
            z,
            pinned: false,
            anchor: anchor.clone(),
            options,
            frozen: None,
            output: output.clone(),
            theme,
            child: child.into_any_element(),
        }
    }

    /// A surface that is not placed against a reference: the child draws itself in window
    /// coordinates (a sheet pinned to the bottom edge, `position: fixed`). The child is as big as
    /// the window and puts its surface where it belongs.
    pub fn pinned(z: Z, theme: Theme, child: impl IntoElement) -> Self {
        let options = Options {
            side: place::Side::Bottom,
            align: place::Align::Center,
            side_offset: 0.,
            padding: place::Padding::content(0.),
            avoid_collisions: false,
        };
        Self {
            pinned: true,
            ..Self::new(
                z,
                &Anchor::default(),
                options,
                &Output::default(),
                theme,
                child,
            )
        }
    }

    /// A closing surface stays where it was.
    pub fn frozen(mut self, at: Option<Resolved>) -> Self {
        self.frozen = at;
        self
    }
}

impl RenderOnce for Popper {
    fn render(self, _: &mut Window, cx: &mut App) -> impl IntoElement {
        let priority = self.z.value(Ds::get(cx));
        deferred(Placed {
            pinned: self.pinned,
            anchor: self.anchor,
            options: self.options,
            frozen: self.frozen,
            output: self.output,
            theme: self.theme,
            child: self.child,
        })
        .priority(priority)
    }
}

struct Placed {
    pinned: bool,
    anchor: Anchor,
    options: Options,
    frozen: Option<Resolved>,
    output: Output,
    theme: Theme,
    child: AnyElement,
}

impl IntoElement for Placed {
    type Element = Self;

    fn into_element(self) -> Self {
        self
    }
}

/// Rounds to whole device pixels (Radix: `roundByDPR`).
fn round_device(value: f32, scale: f32) -> f32 {
    (value * scale).round() / scale
}

impl Element for Placed {
    type RequestLayoutState = Option<LayoutId>;
    type PrepaintState = bool;

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
    ) -> (LayoutId, Option<LayoutId>) {
        let child = self
            .theme
            .scoped(cx, |cx| self.child.request_layout(window, cx));
        let style = Style {
            position: Position::Absolute,
            display: Display::Flex,
            ..Style::default()
        };
        (window.request_layout(style, [child], cx), Some(child))
    }

    fn prepaint(
        &mut self,
        _: Option<&GlobalElementId>,
        _: Option<&InspectorElementId>,
        bounds: Bounds<Pixels>,
        child: &mut Option<LayoutId>,
        window: &mut Window,
        cx: &mut App,
    ) -> bool {
        let Some(child) = *child else {
            return false;
        };
        let size = window.layout_bounds(child).size;
        let size = (f32::from(size.width), f32::from(size.height));
        let viewport = window.viewport_size();
        let viewport = (f32::from(viewport.width), f32::from(viewport.height));
        if self.pinned {
            let origin = point(-bounds.origin.x, -bounds.origin.y);
            self.theme.scoped(cx, |cx| {
                window.with_element_offset(origin, |window| self.child.prepaint(window, cx));
            });
            return true;
        }
        let resolved = match (self.frozen, self.anchor.bounds()) {
            (Some(frozen), _) => Some(frozen),
            (None, Some(reference)) => {
                let reference = Rect {
                    left: f32::from(reference.origin.x),
                    top: f32::from(reference.origin.y),
                    width: f32::from(reference.size.width),
                    height: f32::from(reference.size.height),
                };
                Some(place::resolve(reference, size, viewport, self.options))
            }
            (None, None) => None,
        };
        let Some(resolved) = resolved else {
            return false;
        };
        if self.frozen.is_none() && self.output.0.replace(Some(resolved)) != Some(resolved) {
            // The content sizes itself from this on its next render.
            window.request_animation_frame();
        }
        let scale = window.scale_factor();
        let offset = point(
            px(round_device(resolved.left, scale)) - bounds.origin.x,
            px(round_device(resolved.top, scale)) - bounds.origin.y,
        );
        self.theme.scoped(cx, |cx| {
            window.with_element_offset(offset, |window| self.child.prepaint(window, cx));
        });
        true
    }

    fn paint(
        &mut self,
        _: Option<&GlobalElementId>,
        _: Option<&InspectorElementId>,
        _: Bounds<Pixels>,
        _: &mut Option<LayoutId>,
        placed: &mut bool,
        window: &mut Window,
        cx: &mut App,
    ) {
        if *placed {
            self.theme.scoped(cx, |cx| self.child.paint(window, cx));
        }
    }
}
