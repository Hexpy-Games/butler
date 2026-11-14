use super::{OsrKey, OsrMouse, OsrMouseKind, OsrRuntime, OsrWheel};
use cef::{ImplBrowser, ImplBrowserHost, ImplFrame};

impl OsrRuntime {
    pub fn mouse(&self, page: u64, event: OsrMouse) {
        let Some(h) = self.host(page) else {
            return;
        };
        let pressed = if matches!(event.kind, OsrMouseKind::Up) {
            None
        } else {
            event.button
        };
        let mouse = cef::MouseEvent {
            x: event.x,
            y: event.y,
            modifiers: event.modifiers.flags() | pressed.map_or(0, super::OsrButton::flag),
        };
        match event.kind {
            OsrMouseKind::Move => h.send_mouse_move_event(Some(&mouse), 0),
            OsrMouseKind::Leave => h.send_mouse_move_event(Some(&mouse), 1),
            OsrMouseKind::Down | OsrMouseKind::Up => {
                if let Some(button) = event.button {
                    let up = matches!(event.kind, OsrMouseKind::Up);
                    if !up {
                        h.set_focus(1);
                    }
                    h.send_mouse_click_event(
                        Some(&mouse),
                        button.cef(),
                        i32::from(up),
                        event.click_count,
                    );
                }
            }
        }
    }
    pub fn wheel(&self, page: u64, event: OsrWheel) {
        if let Some(h) = self.host(page) {
            let mouse = cef::MouseEvent {
                x: event.x,
                y: event.y,
                modifiers: event.modifiers.flags(),
            };
            h.send_mouse_wheel_event(Some(&mouse), event.delta_x, event.delta_y);
        }
    }
    pub fn key(&self, page: u64, event: OsrKey) {
        let Some(h) = self.host(page) else {
            return;
        };
        // Cocoa editing commands accompany raw Command shortcuts in OSR.
        if event.modifiers.command
            && !event.up
            && let Some(frame) = self.browser(page).and_then(|b| b.focused_frame())
        {
            match event.windows_key_code {
                65 => frame.select_all(),
                67 => frame.copy(),
                86 => frame.paste(),
                88 => frame.cut(),
                90 => frame.undo(),
                _ => {}
            }
        }
        h.send_key_event(Some(&cef::KeyEvent {
            type_: if event.up {
                cef::KeyEventType::KEYUP
            } else {
                cef::KeyEventType::RAWKEYDOWN
            },
            modifiers: event.modifiers.flags(),
            native_key_code: event.native_key_code,
            windows_key_code: event.windows_key_code,
            character: event.character,
            unmodified_character: event.unmodified_character,
            ..Default::default()
        }));
        // Printable text is committed through IME, preserving macOS composition.
    }
}
