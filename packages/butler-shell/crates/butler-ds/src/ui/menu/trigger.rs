//! The box a trigger control is wrapped in. It takes the control's own width, as a React
//! `asChild` trigger is the control itself: inside a column that stretches its items it starts at
//! the container's edge instead of filling it. That depends on the container being laid out, so
//! the box is a component and decides when it renders.
use gpui::{
    AnyElement, App, Div, IntoElement, ParentElement as _, RenderOnce, Styled as _, Window, div,
};

use crate::ui::strut;

type Wire = Box<dyn FnOnce(Div) -> Div>;

#[derive(IntoElement)]
pub(crate) struct TriggerBox {
    fill: bool,
    wire: Wire,
    child: AnyElement,
}

impl TriggerBox {
    /// `wire` adds the focus tracking and handlers to the box.
    pub(crate) fn new(child: AnyElement, wire: impl FnOnce(Div) -> Div + 'static) -> Self {
        Self {
            fill: false,
            wire: Box::new(wire),
            child,
        }
    }

    /// A trigger that fills its container's width (a `SelectTrigger`).
    pub(crate) fn fill(mut self) -> Self {
        self.fill = true;
        self
    }
}

impl RenderOnce for TriggerBox {
    fn render(self, _: &mut Window, cx: &mut App) -> impl IntoElement {
        let wrapper = div().relative();
        let wrapper = if self.fill {
            wrapper.flex().w_full()
        } else if strut::shrink_wrap(cx) {
            wrapper.inline_flex().flex_none().self_start()
        } else {
            wrapper.inline_flex().flex_none()
        };
        (self.wire)(wrapper).child(self.child)
    }
}
