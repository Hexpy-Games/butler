use super::surface::Page;
use butler_cef_host::osr::{OsrButton, OsrKey, OsrModifiers, OsrMouse, OsrMouseKind, OsrWheel};
use gpui::{
    Context, Keystroke, Modifiers, MouseButton, MouseDownEvent, MouseExitEvent, MouseMoveEvent,
    MouseUpEvent, NativeKeyData, Pixels, Point, ScrollWheelEvent, Window, px,
};

impl Page {
    #[expect(
        clippy::too_many_arguments,
        reason = "native mouse fields plus the gpui window and context"
    )]
    fn mouse(
        &self,
        position: Point<Pixels>,
        modifiers: Modifiers,
        button: Option<MouseButton>,
        kind: OsrMouseKind,
        clicks: usize,
        window: &mut Window,
        cx: &mut gpui::App,
    ) {
        let Some(runtime) = self.runtime.upgrade() else {
            return;
        };
        let point = position - self.state.borrow().bounds.origin;
        if let Some(id) = self.state.borrow().tab.clone() {
            if matches!(kind, OsrMouseKind::Down | OsrMouseKind::Up)
                && button != Some(MouseButton::Left)
                && cx
                    .global::<crate::ui::browser::model::BrowserState>()
                    .tab(&id)
                    .is_some_and(|t| t.picking)
            {
                return;
            }
            use crate::ui::browser::pick::{self, Mouse};
            let kind = match kind {
                OsrMouseKind::Move => Mouse::Move,
                OsrMouseKind::Leave => Mouse::Leave,
                OsrMouseKind::Down => Mouse::Down,
                OsrMouseKind::Up => Mouse::Up,
            };
            if pick::mouse(
                &id,
                f64::from(f32::from(point.x)),
                f64::from(f32::from(point.y)),
                modifiers,
                kind,
                window,
                cx,
            ) {
                return;
            }
        }
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
            window,
            cx,
        );
    }
    pub(super) fn mouse_up(
        &mut self,
        e: &MouseUpEvent,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        self.mouse(
            e.position,
            e.modifiers,
            Some(e.button),
            OsrMouseKind::Up,
            e.click_count,
            window,
            cx,
        );
    }
    pub(super) fn mouse_move(
        &mut self,
        e: &MouseMoveEvent,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        self.mouse(
            e.position,
            e.modifiers,
            e.pressed_button,
            OsrMouseKind::Move,
            0,
            window,
            cx,
        );
    }
    pub(super) fn mouse_exit(
        &mut self,
        e: &MouseExitEvent,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        self.mouse(
            e.position,
            e.modifiers,
            e.pressed_button,
            OsrMouseKind::Leave,
            0,
            window,
            cx,
        );
    }
    pub(super) fn wheel(&mut self, e: &ScrollWheelEvent, _: &mut Window, cx: &mut Context<Self>) {
        let Some(runtime) = self.runtime.upgrade() else {
            return;
        };
        let point = e.position - self.state.borrow().bounds.origin;
        let delta = e.delta.pixel_delta(px(line()));
        if e.modifiers.alt
            && let Some(id) = self.state.borrow().tab.clone()
            && cx
                .global::<crate::ui::browser::model::BrowserState>()
                .tab(&id)
                .is_some_and(|t| t.picking)
        {
            crate::ui::browser::pick::wheel(&id, f32::from(delta.y), cx);
            return;
        }
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
    pub(super) fn key(
        &self,
        key: &Keystroke,
        native: Option<NativeKeyData>,
        up: bool,
        cx: &mut gpui::App,
    ) {
        if let Some(id) = self.state.borrow().tab.clone()
            && crate::ui::browser::pick::key(&id, key, up, cx)
        {
            cx.stop_propagation();
            return;
        }
        let Some(runtime) = self.runtime.upgrade() else {
            return;
        };
        if !up {
            self.state
                .borrow()
                .last_input
                .set(Some(std::time::Instant::now()));
        }
        let (windows_key_code, native_key_code) = codes(&key.key, native);
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
/// Pixels per wheel line. Windows reports notches times the user's lines setting, which Chromium
/// scrolls at 100/3 px per line (100 px per notch at the default 3 lines).
fn line() -> f32 {
    if super::windows() { 100. / 3. } else { 20. }
}
/// The Windows virtual key and the platform key code. A Windows key message gives both: its
/// virtual key and its lParam (CEF's `native_key_code`, which sets the DOM `code`; a WM_CHAR
/// translated from the key shares it). Otherwise both come from the key name: macOS's virtual key
/// code, or on Windows lParam 0 for a keystroke gpui synthesized without a key message.
#[expect(
    clippy::cast_possible_truncation,
    reason = "a key message's lParam is 32 bits; CEF takes it as int, as cefclient does"
)]
fn codes(key: &str, native: Option<NativeKeyData>) -> (i32, i32) {
    if let Some(data) = native.as_ref().and_then(NativeKeyData::windows) {
        return (i32::from(data.virtual_key), data.lparam as i32);
    }
    let (windows_key_code, mac) = key_codes(key);
    (windows_key_code, if super::windows() { 0 } else { mac })
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
