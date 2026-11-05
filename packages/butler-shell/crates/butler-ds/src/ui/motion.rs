//! Motion on the DS tokens. Reduced motion is the OS setting or the app setting, both held by
//! [`Ds`]; the tokens already zero the distances and scales under it, so token-driven motion
//! becomes a pure opacity fade. [`Tween`] therefore does not consult gpui's own
//! `App::reduce_motion` (which would freeze fades as well). Loops follow [`Loop`].
use std::time::{Duration, Instant};

use gpui::{
    AnyElement, App, Bounds, Element, ElementId, GlobalElementId, InspectorElementId, IntoElement,
    LayoutId, Pixels, Window,
};

use super::context::Ds;
use super::convert;
use crate::tokens::{Duration as DsDuration, Easing};

/// A repeating animation, and whether reduced motion stops it.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Loop {
    /// Decorative loops (pulses, shimmers) stop under reduced motion.
    Decorative,
    /// The spinner keeps rotating under reduced motion (owner decision).
    Spinner,
}

impl Loop {
    pub fn runs(self, ds: &Ds) -> bool {
        self == Self::Spinner || !ds.reduced_motion()
    }
}

/// One timed animation: its duration and easing curve (a token's, or any function).
pub struct Timing {
    pub duration: Duration,
    ease: Box<dyn Fn(f32) -> f32>,
}

impl Timing {
    pub fn token(ds: &Ds, duration: DsDuration, ease: Easing) -> Self {
        Self {
            duration: ds.duration(duration),
            ease: Box::new(convert::easing(ds.tokens().ease(ease))),
        }
    }

    pub fn linear(duration: Duration) -> Self {
        Self {
            duration,
            ease: Box::new(|x| x),
        }
    }
}

/// An element whose appearance is a function of animation progress (eased 0 to 1).
pub struct Tween<E> {
    id: ElementId,
    element: Option<E>,
    timing: Timing,
    repeat: bool,
    apply: Box<dyn Fn(E, f32) -> E>,
}

impl<E: IntoElement + 'static> Tween<E> {
    pub fn new(
        id: impl Into<ElementId>,
        element: E,
        timing: Timing,
        apply: impl Fn(E, f32) -> E + 'static,
    ) -> Self {
        Self {
            id: id.into(),
            element: Some(element),
            timing,
            repeat: false,
            apply: Box::new(apply),
        }
    }

    pub fn repeat(mut self) -> Self {
        self.repeat = true;
        self
    }
}

impl<E: IntoElement + 'static> IntoElement for Tween<E> {
    type Element = Self;

    fn into_element(self) -> Self {
        self
    }
}

impl<E: IntoElement + 'static> Element for Tween<E> {
    type RequestLayoutState = AnyElement;
    type PrepaintState = ();

    fn id(&self) -> Option<ElementId> {
        Some(self.id.clone())
    }

    fn source_location(&self) -> Option<&'static core::panic::Location<'static>> {
        None
    }

    fn request_layout(
        &mut self,
        id: Option<&GlobalElementId>,
        _: Option<&InspectorElementId>,
        window: &mut Window,
        cx: &mut App,
    ) -> (LayoutId, AnyElement) {
        let Some(id) = id else {
            let empty = gpui::Empty.into_any_element();
            return (window.request_layout(gpui::Style::default(), [], cx), empty);
        };
        let now = cx.background_executor().now();
        let start = window.with_element_state(id, |start: Option<Instant>, _| {
            let start = start.unwrap_or(now);
            (start, start)
        });
        let total = self.timing.duration.as_secs_f32();
        let elapsed = now.saturating_duration_since(start).as_secs_f32();
        let (linear, done) = if total <= 0. {
            (1., true)
        } else if self.repeat {
            ((elapsed / total).fract(), false)
        } else {
            ((elapsed / total).min(1.), elapsed >= total)
        };
        if !done {
            window.request_animation_frame();
        }
        let eased = (self.timing.ease)(linear);
        let element = self.element.take().map(|e| (self.apply)(e, eased));
        let mut element = element.map_or_else(
            || gpui::Empty.into_any_element(),
            IntoElement::into_any_element,
        );
        (element.request_layout(window, cx), element)
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
        &mut (): &mut (),
        window: &mut Window,
        cx: &mut App,
    ) {
        element.paint(window, cx);
    }
}
