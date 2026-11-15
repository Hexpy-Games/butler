use super::surface::Page;
use butler_cef_host::osr::{OsrButton, OsrKey, OsrModifiers, OsrMouse, OsrMouseKind, OsrWheel};
use gpui::{
    Context, Keystroke, Modifiers, MouseButton, MouseDownEvent, MouseExitEvent, MouseMoveEvent,
    MouseUpEvent, Pixels, Point, ScrollWheelEvent, Window, px,
};

impl Page {
    fn mouse(
        &self,
        position: Point<Pixels>,
        modifiers: Modifiers,
        button: Option<MouseButton>,
        kind: OsrMouseKind,
        clicks: usize,
    ) {
        let Some(runtime) = self.runtime.upgrade() else {
            return;
        };
        let point = position - self.state.borrow().bounds.origin;
        runtime.mouse(
            self.id,
            OsrMouse {
                x: coordinate(point.x),
                y: coordinate(point.y),
                modifiers: flags(modifiers),
                kind,
                button: button.and_then(osr_button),
                click_count: i32::try_from(clicks).unwrap_or(i32::MAX),
            },
        );
    }
    pub(super) fn mouse_down(
        &mut self,
        e: &MouseDownEvent,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        self.state
            .borrow()
            .last_input
            .set(Some(std::time::Instant::now()));
        window.focus(&self.focus, cx);
        self.mouse(
            e.position,
            e.modifiers,
            Some(e.button),
            OsrMouseKind::Down,
            e.click_count,
        );
    }
    pub(super) fn mouse_up(&mut self, e: &MouseUpEvent, _: &mut Window, _: &mut Context<Self>) {
        self.mouse(
            e.position,
            e.modifiers,
            Some(e.button),
            OsrMouseKind::Up,
            e.click_count,
        );
    }
    pub(super) fn mouse_move(&mut self, e: &MouseMoveEvent, _: &mut Window, _: &mut Context<Self>) {
        self.mouse(
            e.position,
            e.modifiers,
            e.pressed_button,
            OsrMouseKind::Move,
            0,
        );
    }
    pub(super) fn mouse_exit(&mut self, e: &MouseExitEvent, _: &mut Window, _: &mut Context<Self>) {
        self.mouse(
            e.position,
            e.modifiers,
            e.pressed_button,
            OsrMouseKind::Leave,
            0,
        );
    }
    pub(super) fn wheel(&mut self, e: &ScrollWheelEvent, _: &mut Window, _: &mut Context<Self>) {
        let Some(runtime) = self.runtime.upgrade() else {
            return;
        };
        let point = e.position - self.state.borrow().bounds.origin;
        let delta = e.delta.pixel_delta(px(20.));
        runtime.wheel(
            self.id,
            OsrWheel {
                x: coordinate(point.x),
                y: coordinate(point.y),
                modifiers: flags(e.modifiers),
                delta_x: coordinate(delta.x),
                delta_y: coordinate(delta.y),
            },
        );
    }
    pub(super) fn key(&self, key: &Keystroke, up: bool) {
        let Some(runtime) = self.runtime.upgrade() else {
            return;
        };
        if !up {
            self.state
                .borrow()
                .last_input
                .set(Some(std::time::Instant::now()));
        }
        let (windows_key_code, native_key_code) = key_codes(&key.key);
        let character = key
            .key_char
            .as_deref()
            .and_then(|s| s.encode_utf16().next())
            .unwrap_or(0);
        runtime.key(
            self.id,
            OsrKey {
                native_key_code,
                windows_key_code,
                character,
                unmodified_character: key.key.encode_utf16().next().unwrap_or(0),
                modifiers: flags(key.modifiers),
                up,
            },
        );
    }
}
fn osr_button(button: MouseButton) -> Option<OsrButton> {
    match button {
        MouseButton::Left => Some(OsrButton::Left),
        MouseButton::Middle => Some(OsrButton::Middle),
        MouseButton::Right => Some(OsrButton::Right),
        MouseButton::Navigate(_) => None,
    }
}
fn flags(modifiers: Modifiers) -> OsrModifiers {
    OsrModifiers {
        shift: modifiers.shift,
        control: modifiers.control,
        alt: modifiers.alt,
        command: modifiers.platform,
    }
}
#[expect(
    clippy::cast_possible_truncation,
    reason = "bounded UI pixel coordinates"
)]
fn coordinate(value: Pixels) -> i32 {
    f32::from(value).round() as i32
}
#[expect(
    clippy::cast_possible_truncation,
    clippy::cast_sign_loss,
    reason = "positive UI pixel dimensions"
)]
pub(super) fn dimension(value: Pixels) -> u32 {
    f32::from(value).round().max(1.) as u32
}
fn key_codes(key: &str) -> (i32, i32) {
    match key {
        "left" => (37, 123),
        "right" => (39, 124),
        "up" => (38, 126),
        "down" => (40, 125),
        "backspace" => (8, 51),
        "delete" => (46, 117),
        "enter" => (13, 36),
        "tab" => (9, 48),
        "escape" => (27, 53),
        "home" => (36, 115),
        "end" => (35, 119),
        "a" => (65, 0),
        "c" => (67, 8),
        "v" => (86, 9),
        "x" => (88, 7),
        "z" => (90, 6),
        _ => (
            key.to_uppercase()
                .chars()
                .next()
                .map(|c| c as i32)
                .unwrap_or(0),
            0,
        ),
    }
}
