//! Electron's `app-region`: a band that moves the window, and the controls inside it that do not.
use gpui::{
    DispatchPhase, Div, InteractiveElement as _, MouseButton, MouseDownEvent, MouseUpEvent,
    ParentElement as _, Styled as _, WindowControlArea, canvas,
};
use std::cell::Cell;

thread_local!(static ARMED: Cell<bool> = const { Cell::new(false) });
thread_local!(static NO_DRAG: Cell<bool> = const { Cell::new(false) });

/// A window drag band: a press and move moves the window, a double click does what the system
/// setting says. On Windows the band also answers the OS hit test, which moves and maximizes
/// itself before a move reaches these handlers.
pub fn area(el: Div) -> Div {
    el.window_control_area(WindowControlArea::Drag)
        .on_mouse_down(MouseButton::Left, |event, window, _| {
            if window.is_fullscreen() {
                return;
            }
            if event.click_count == 2 {
                ARMED.set(false);
                if !NO_DRAG.replace(false) {
                    window.titlebar_double_click();
                }
            } else {
                ARMED.set(!NO_DRAG.replace(false));
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
    el.on_mouse_down(MouseButton::Left, |_, _, cx| {
        ARMED.set(false);
        NO_DRAG.set(false);
        cx.stop_propagation();
    })
    .child(
        canvas(
            |_, _, _| (),
            |bounds, (), window, _| {
                let rect = bounds.intersect(&window.content_mask().bounds);
                window.on_mouse_event(move |e: &MouseDownEvent, phase, _, _| {
                    if phase == DispatchPhase::Capture
                        && e.button == MouseButton::Left
                        && rect.contains(&e.position)
                    {
                        NO_DRAG.set(true);
                    }
                });
                window.on_mouse_event(|_: &MouseUpEvent, phase, _, _| {
                    if phase == DispatchPhase::Capture {
                        NO_DRAG.set(false);
                    }
                });
            },
        )
        .absolute()
        .inset_0(),
    )
}
