//! The presence of the overlay a glass surface is in: an enter or exit animation's progress
//! (0..=1), passed down the subtree like [`crate::ui::blocks::scope`]'s values. An overlay wraps
//! its surface in [`with_presence`] instead of fading it; the glass inside reads [`presence`] and
//! materializes by it, while its content fades (LG research §5 Appear/disappear, §8.1.6).
use gpui::{
    AnyElement, App, Bounds, Element, ElementId, GlobalElementId, InspectorElementId, IntoElement,
    LayoutId, Pixels, Window,
};

use crate::ui::motion::Timing;

/// Static presence or a retained materialization on the animation clock.
#[derive(Clone, Copy)]
pub enum Presence {
    Static(f32),
    Moving {
        from: f32,
        to: f32,
        start_ms: u32,
        timing: Timing,
    },
}

/// The enclosing presences, innermost last; `None` ends the scope for a glass's own children.
#[derive(Default)]
struct Presences(Vec<Option<Presence>>);

impl gpui::Global for Presences {}

/// The presence of the innermost enclosing overlay, if the caller is inside one.
pub fn presence(cx: &App) -> Option<Presence> {
    cx.try_global::<Presences>()
        .and_then(|stack| stack.0.last().copied().flatten())
}

/// Whether the caller paints inside a glass's content ([`without_presence`]): a glass there is a
/// glass on glass (LG research §4.2).
pub fn on_glass(cx: &App) -> bool {
    cx.try_global::<Presences>()
        .and_then(|stack| stack.0.last())
        .is_some_and(Option::is_none)
}

pub struct WithPresence {
    value: Option<Presence>,
    child: Option<AnyElement>,
}

/// `child` laid out, prepainted and painted with presence `t` in effect.
pub fn with_presence(t: Presence, child: impl IntoElement) -> WithPresence {
    WithPresence {
        value: Some(t),
        child: Some(child.into_any_element()),
    }
}

/// `child` with no presence in effect: a glass's content does not inherit its own presence.
pub fn without_presence(child: impl IntoElement) -> WithPresence {
    WithPresence {
        value: None,
        child: Some(child.into_any_element()),
    }
}

impl IntoElement for WithPresence {
    type Element = Self;

    fn into_element(self) -> Self {
        self
    }
}

fn within<R>(value: Option<Presence>, cx: &mut App, f: impl FnOnce(&mut App) -> R) -> R {
    cx.default_global::<Presences>().0.push(value);
    let out = f(cx);
    cx.default_global::<Presences>().0.pop();
    out
}

impl Element for WithPresence {
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
        let layout = within(self.value, cx, |cx| child.request_layout(window, cx));
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
        within(self.value, cx, |cx| child.prepaint(window, cx));
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
        within(self.value, cx, |cx| child.paint(window, cx));
    }
}
