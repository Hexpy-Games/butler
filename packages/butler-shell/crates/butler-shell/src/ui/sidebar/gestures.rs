//! The row's long press and context menu share the same controlled menu state.
use super::Shell;
use gpui::{Context, Div, MouseButton, MouseDownEvent, MouseMoveEvent, Stateful, prelude::*};
impl Shell {
    pub(super) fn row_gestures(
        element: Stateful<Div>,
        key: String,
        instance: String,
        cx: &Context<Self>,
    ) -> Stateful<Div> {
        let menu_instance = instance.clone();
        let press_key = key.clone();
        element
            .on_mouse_down(
                MouseButton::Right,
                cx.listener(move |s, _, _, cx| {
                    cx.stop_propagation();
                    s.open_row_menu(&key, &menu_instance, cx);
                }),
            )
            .on_mouse_down(
                MouseButton::Left,
                cx.listener(move |s, event: &MouseDownEvent, _, cx| {
                    s.row_press(press_key.clone(), instance.clone(), event.position, cx);
                }),
            )
            .on_mouse_move(cx.listener(|s, event: &MouseMoveEvent, _, _| {
                if s.sidebar
                    .long_press_origin
                    .is_some_and(|origin| (event.position - origin).magnitude() > f64::from(gpui::px(10.)))
                {
                    s.sidebar.cancel_long_press();
                }
            }))
            .on_mouse_up(
                MouseButton::Left,
                cx.listener(|s, _, _, _| s.sidebar.cancel_long_press()),
            )
            .on_mouse_up_out(
                MouseButton::Left,
                cx.listener(|s, _, _, _| s.sidebar.cancel_long_press()),
            )
    }
    pub(super) fn open_row_menu(&mut self, key: &str, instance: &str, cx: &mut Context<Self>) {
        self.sidebar.menus.insert(instance.to_owned());
        if key == "s:general" {
            self.load_general_menu(cx);
        }
        cx.notify();
    }
    pub(super) fn row_press(
        &mut self,
        key: String,
        instance: String,
        origin: gpui::Point<gpui::Pixels>,
        cx: &mut Context<Self>,
    ) {
        if self.sidebar.long_press_key.is_some() {
            return;
        }
        self.sidebar.long_press_fired = None;
        self.sidebar.long_press_key = Some(instance.clone());
        self.sidebar.long_press_origin = Some(origin);
        self.sidebar.long_press_task = Some(cx.spawn(async move |weak, cx| {
            cx.background_executor()
                .timer(std::time::Duration::from_millis(500))
                .await;
            let _ = weak.update(cx, |s, cx| {
                if s.sidebar.long_press_key.as_ref() == Some(&instance) && !cx.has_active_drag() {
                    s.sidebar.cancel_long_press();
                    s.sidebar.long_press_fired = Some(instance.clone());
                    s.open_row_menu(&key, &instance, cx);
                }
            });
        }));
    }
}
