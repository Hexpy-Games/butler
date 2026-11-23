//! Electron's `app-region`: a band that moves the window, and the controls inside it that do not.
use gpui::{Div, InteractiveElement as _, MouseButton, WindowControlArea};
use std::cell::Cell;

thread_local!(static ARMED: Cell<bool> = const { Cell::new(false) });

/// A window drag band: a press and move moves the window, a double click does what the system
/// setting says. On Windows the band answers the OS hit test through the same
/// `window_control_area_at_mouse` map, so a no-drag rect is never HTCAPTION, even under an overlay.
pub fn area(el: Div) -> Div {
    el.window_control_area(WindowControlArea::Drag)
        .on_mouse_down(MouseButton::Left, |event, window, _| {
            if window.is_fullscreen() {
                return;
            }
            let drag = window.window_control_area_at_mouse() == Some(WindowControlArea::Drag);
            if event.click_count == 2 {
                ARMED.set(false);
                if drag {
                    window.titlebar_double_click();
                }
            } else {
                ARMED.set(drag);
            }
        })
        .on_mouse_down_out(|_, _, _| ARMED.set(false))
        .on_mouse_move(|event, window, _| {
            if ARMED.replace(false) && event.pressed_button == Some(MouseButton::Left) {
                window.start_window_move();
            }
        })
        .on_mouse_up(MouseButton::Left, |_, _, _| ARMED.set(false))
}

/// Whether the last press armed a window move; clears it. For the test harness only.
#[doc(hidden)]
pub fn take_armed() -> bool {
    ARMED.replace(false)
}

/// A control inside a drag band: it takes the press, so the band never moves the window from it.
pub fn no_drag(el: Div) -> Div {
    el.window_control_area(WindowControlArea::NoDrag)
        .on_mouse_down(MouseButton::Left, |_, _, cx| {
            ARMED.set(false);
            cx.stop_propagation();
        })
}
