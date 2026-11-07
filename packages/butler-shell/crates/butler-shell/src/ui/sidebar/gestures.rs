//! The row's long press and context menu share the same controlled menu state.
use super::Shell;
use gpui::{Context, Div, MouseButton, Stateful, prelude::*};
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
                cx.listener(move |s, _, _, cx| {
                    cx.stop_propagation();
                    s.row_press(press_key.clone(), instance.clone(), cx);
                }),
            )
            .on_mouse_up(
                MouseButton::Left,
                cx.listener(|s, _, _, _| s.sidebar.long_press_key = None),
            )
            .on_mouse_up_out(
                MouseButton::Left,
                cx.listener(|s, _, _, _| s.sidebar.long_press_key = None),
            )
    }
    pub(super) fn open_row_menu(&mut self, key: &str, instance: &str, cx: &mut Context<Self>) {
        self.sidebar.menus.insert(instance.to_owned());
        if key == "s:general" {
            self.load_general_menu(cx);
        }
        cx.notify();
    }
    pub(super) fn row_press(&mut self, key: String, instance: String, cx: &mut Context<Self>) {
        if self.sidebar.long_press_key.is_some() {
            return;
        }
        self.sidebar.long_press_fired = None;
        self.sidebar.long_press_key = Some(instance.clone());
        cx.spawn(async move |weak, cx| {
            cx.background_executor()
                .timer(std::time::Duration::from_millis(500))
                .await;
            let _ = weak.update(cx, |s, cx| {
                if s.sidebar.long_press_key.as_ref() == Some(&instance) && !cx.has_active_drag() {
                    s.sidebar.long_press_key = None;
                    s.sidebar.long_press_fired = Some(instance.clone());
                    s.open_row_menu(&key, &instance, cx);
                }
            });
        })
        .detach();
    }
}
