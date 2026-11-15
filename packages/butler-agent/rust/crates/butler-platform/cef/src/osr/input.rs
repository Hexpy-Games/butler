use super::{OsrKey, OsrMouse, OsrMouseKind, OsrRuntime, OsrWheel};
use cef::ImplBrowserHost;
#[cfg(target_os = "macos")]
use cef::{ImplBrowser, ImplFrame};

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
        #[cfg(target_os = "macos")]
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
            #[cfg(windows)]
            is_system_key: i32::from(event.system_key),
            ..Default::default()
        }));
        // Printable text is committed through IME, preserving macOS composition.
        // Windows: Chromium edits Enter, Tab, Backspace and Escape on their WM_CHAR, which
        // TranslateMessage would post; printable text still arrives through IME commit.
        #[cfg(windows)]
        if let Some(character) = control_char(&event) {
            h.send_key_event(Some(&cef::KeyEvent {
                type_: cef::KeyEventType::CHAR,
                modifiers: event.modifiers.flags(),
                native_key_code: event.native_key_code,
                windows_key_code: i32::from(character),
                character,
                unmodified_character: character,
                ..Default::default()
            }));
        }
    }
}

/// The WM_CHAR TranslateMessage posts for a key-down of Enter, Tab, Backspace or Escape.
#[cfg(windows)]
fn control_char(event: &OsrKey) -> Option<u16> {
    if event.up || event.modifiers.alt {
        return None;
    }
    // VK_BACK, VK_TAB, VK_RETURN and VK_ESCAPE equal their plain WM_CHAR codes.
    match (
        u16::try_from(event.windows_key_code).ok()?,
        event.modifiers.control,
    ) {
        (code @ (0x08 | 0x09 | 0x0D | 0x1B), false) => Some(code),
        (0x0D, true) => Some(0x0A),
        (0x08, true) => Some(0x7F),
        _ => None,
    }
}
