//! SheetHandle (BottomSheet.tsx `SheetHandle`, BottomSheet.module.css `.handle`, `.grabber`): the
//! grabber row, a drag handle for the whole sheet. The pointer is captured for the drag: the
//! window's move and release events reach the sheet wherever the pointer goes. With a label the
//! grabber is a button that closes the sheet; without one it is decorative (a presented menu,
//! popover or select closes with Escape, the backdrop or a choice).
use std::rc::Rc;

use gpui::{
    AnyElement, App, CursorStyle, ElementId, Entity, InteractiveElement as _, IntoElement,
    MouseButton, MouseMoveEvent, MouseUpEvent, ParentElement as _, RenderOnce, SharedString,
    Styled as _, Window, canvas, div, px,
};

use super::drag::Outcome;
use super::state::SheetState;
use crate::tokens::{Color, Length};
use crate::ui::context::Ds;
use crate::ui::control::{Blend, Control, Disabled};

/// The grabber button. // DS: BottomSheet.module.css:164 (48x20)
const GRABBER: (f32, f32) = (48., 20.);
/// The pill the grabber draws. // DS: BottomSheet.module.css:176 (36x5)
const PILL: (f32, f32) = (36., 5.);

type Action = Rc<dyn Fn(&mut Window, &mut App)>;

#[derive(IntoElement)]
pub struct SheetHandle {
    id: ElementId,
    state: Entity<SheetState>,
    close_label: Option<SharedString>,
    on_close: Action,
}

impl SheetHandle {
    /// `on_close` runs for the grabber button and for a drag that dismisses.
    pub fn new(
        id: impl Into<ElementId>,
        state: &Entity<SheetState>,
        on_close: impl Fn(&mut Window, &mut App) + 'static,
    ) -> Self {
        Self {
            id: id.into(),
            state: state.clone(),
            close_label: None,
            on_close: Rc::new(on_close),
        }
    }

    /// The grabber's name: it is a button that closes the sheet.
    pub fn close_label(mut self, label: impl Into<SharedString>) -> Self {
        self.close_label = Some(label.into());
        self
    }
}

/// The pill in the grabber, in `--line-strong`.
fn pill(ds: &Ds) -> gpui::Div {
    div()
        .w(px(PILL.0))
        .h(px(PILL.1))
        .rounded(ds.len(Length::RadiusPill))
        .bg(ds.color(Color::LineStrong))
}

impl SheetHandle {
    /// The grabber button: transparent, closes the sheet unless the press was a drag.
    fn button(&self, ds: &Ds) -> AnyElement {
        let mut control = Control::new((self.id.clone(), "grabber"), ds);
        control.width = crate::ui::control::Width::Fixed(GRABBER.0);
        control.height = Some(px(GRABBER.1));
        control.radius = ds.len(Length::RadiusControl);
        control.scale = false;
        control.disabled = Disabled::No;
        control.fill = Blend::flat(gpui::transparent_black());
        control.children = vec![pill(ds).into_any_element()];
        let (state, close) = (self.state.clone(), self.on_close.clone());
        control.on_click(Some(Rc::new(move |_, window, cx| {
            if !state.update(cx, |state, _| state.take_moved()) {
                close(window, cx);
            }
        })));
        control.into_any_element()
    }

    /// The decorative grabber.
    fn mark(ds: &Ds) -> AnyElement {
        div()
            .flex()
            .items_center()
            .justify_center()
            .w(px(GRABBER.0))
            .h(px(GRABBER.1))
            .child(pill(ds))
            .into_any_element()
    }
}

impl RenderOnce for SheetHandle {
    fn render(self, _: &mut Window, cx: &mut App) -> impl IntoElement {
        let ds = Ds::get(cx);
        let grabber = if self.close_label.is_some() {
            self.button(ds)
        } else {
            Self::mark(ds)
        };
        let pad = ds.len(Length::Space1);
        let (dragging, state) = (self.state.read(cx).dragging(), self.state.clone());
        let down = state.clone();
        let surface = self.state.read(cx).surface.clone();
        let capture = capture(&self, dragging);
        div()
            .id((self.id, "row"))
            .flex()
            .flex_none()
            .justify_center()
            .pt(pad)
            .debug_selector(|| "sheet-handle".to_owned())
            .cursor(if dragging {
                CursorStyle::ClosedHand
            } else {
                CursorStyle::OpenHand
            })
            .on_mouse_down(MouseButton::Left, move |event, _, cx| {
                let now = cx.background_executor().now();
                let high = surface
                    .bounds()
                    .map_or(0., |bounds| f32::from(bounds.size.height));
                down.update(cx, |state, cx| {
                    state.press(f32::from(event.position.y), now, high);
                    cx.notify();
                });
            })
            .child(grabber)
            .children(capture)
    }
}

/// While a drag is in progress: the window's pointer events steer the sheet (pointer capture).
fn capture(handle: &SheetHandle, dragging: bool) -> Option<AnyElement> {
    if !dragging {
        return None;
    }
    let (state, close) = (handle.state.clone(), handle.on_close.clone());
    Some(
        canvas(
            |_, _, _| (),
            move |_, (), window, _| {
                let moving = state.clone();
                window.on_mouse_event(move |event: &MouseMoveEvent, phase, window, cx| {
                    if !phase.capture() {
                        return;
                    }
                    let now = cx.background_executor().now();
                    moving.update(cx, |state, cx| {
                        state.follow(f32::from(event.position.y), now);
                        cx.notify();
                    });
                    window.refresh();
                });
                let (state, close) = (state.clone(), close.clone());
                window.on_mouse_event(move |event: &MouseUpEvent, phase, window, cx| {
                    if !phase.capture() || event.button != MouseButton::Left {
                        return;
                    }
                    let now = cx.background_executor().now();
                    let outcome = state.update(cx, |state, cx| {
                        cx.notify();
                        state.release(f32::from(event.position.y), now)
                    });
                    if outcome == Some(Outcome::Dismiss) {
                        close(window, cx);
                    }
                    window.refresh();
                });
            },
        )
        .absolute()
        .size_0()
        .into_any_element(),
    )
}
