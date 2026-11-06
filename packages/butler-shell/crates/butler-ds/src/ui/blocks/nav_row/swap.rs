//! DS NavRowSwap (NavRowSwap.tsx): a trailing NavRow slot that shows its rest content (a
//! status, a disclosure chevron) at rest and swaps in row actions on row hover or keyboard
//! focus (a fade on `--motion-fast`). Phones keep the rest content (row menus open with a long
//! press). Clicks inside never reach the row.
use gpui::{
    AnyElement, App, ElementId, InteractiveElement as _, IntoElement, MouseButton,
    ParentElement as _, RenderOnce, StatefulInteractiveElement as _, Styled as _, Window, div,
    prelude::FluentBuilder as _,
};

use crate::ui::blocks::scope;
use crate::ui::context::Ds;

#[derive(IntoElement)]
pub struct NavRowSwap {
    id: ElementId,
    rest: Option<AnyElement>,
    reveal: AnyElement,
    open: bool,
}

impl NavRowSwap {
    /// `reveal` is shown over the rest content while the row is hovered or holds keyboard focus.
    pub fn new(id: impl Into<ElementId>, reveal: impl IntoElement) -> Self {
        Self {
            id: id.into(),
            rest: None,
            reveal: reveal.into_any_element(),
            open: false,
        }
    }

    /// What the slot shows at rest; may be empty.
    pub fn rest(mut self, rest: impl IntoElement) -> Self {
        self.rest = Some(rest.into_any_element());
        self
    }

    /// Keeps the revealed content shown, for example while its menu is open.
    pub fn open(mut self, open: bool) -> Self {
        self.open = open;
        self
    }
}

impl RenderOnce for NavRowSwap {
    fn render(self, _: &mut Window, cx: &mut App) -> impl IntoElement {
        // Phones keep the rest content (`@media (width > 640px)`).
        let desktop = !Ds::get(cx).compact();
        let reveal = if self.open && desktop {
            1.
        } else if desktop {
            scope::row_reveal(cx).unwrap_or(0.)
        } else {
            0.
        };
        let shown = reveal > 0.001;
        // Row actions stay out of the hit test while hidden (`pointer-events: none`).
        let revealed = div()
            .flex()
            .items_center()
            .justify_center()
            .opacity(reveal)
            .when(!shown, gpui::Styled::invisible)
            .child(self.reveal);
        div()
            .id(self.id)
            .relative()
            .flex()
            .flex_none()
            .on_mouse_down(MouseButton::Left, |_, _, cx| cx.stop_propagation())
            .on_click(|_, _, cx| cx.stop_propagation())
            .child(revealed)
            .children(self.rest.map(|rest| {
                div()
                    .absolute()
                    .top_0()
                    .left_0()
                    .size_full()
                    .flex()
                    .items_center()
                    .justify_center()
                    .when(shown, gpui::Styled::invisible)
                    .child(rest)
            }))
    }
}
