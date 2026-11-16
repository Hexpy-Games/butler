use super::surface::Page;
use butler_cef_host::osr::{OsrButton, OsrKey, OsrModifiers, OsrMouse, OsrMouseKind, OsrWheel};
use gpui::{
    Context, Keystroke, Modifiers, MouseButton, MouseDownEvent, MouseExitEvent, MouseMoveEvent,
    MouseUpEvent, NativeKeyData, Pixels, Point, ScrollDelta, ScrollWheelEvent, Window,
    WindowsKeyData, px,
};

impl Page {
    fn mouse(
        &self,
        position: Point<Pixels>,
        modifiers: Modifiers,
        button: Option<MouseButton>,
        kind: OsrMouseKind,
        clicks: usize,
        zoom: f32,
    ) {
        let Some(runtime) = self.runtime.upgrade() else {
            return;
        };
        // Page pixels are native logical pixels: content pixels times the window zoom.
        let point = (position - self.state.borrow().bounds.origin) * zoom;
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
            window.zoom(),
        );
    }
    pub(super) fn mouse_up(
        &mut self,
        e: &MouseUpEvent,
        window: &mut Window,
        _: &mut Context<Self>,
    ) {
        self.mouse(
            e.position,
            e.modifiers,
            Some(e.button),
            OsrMouseKind::Up,
            e.click_count,
            window.zoom(),
        );
    }
    pub(super) fn mouse_move(
        &mut self,
        e: &MouseMoveEvent,
        window: &mut Window,
        _: &mut Context<Self>,
    ) {
        self.mouse(
            e.position,
            e.modifiers,
            e.pressed_button,
            OsrMouseKind::Move,
            0,
            window.zoom(),
        );
    }
    pub(super) fn mouse_exit(
        &mut self,
        e: &MouseExitEvent,
        window: &mut Window,
        _: &mut Context<Self>,
    ) {
        self.mouse(
            e.position,
            e.modifiers,
            e.pressed_button,
            OsrMouseKind::Leave,
            0,
            window.zoom(),
        );
    }
    pub(super) fn wheel(
        &mut self,
        e: &ScrollWheelEvent,
        window: &mut Window,
        _: &mut Context<Self>,
    ) {
        let Some(runtime) = self.runtime.upgrade() else {
            return;
        };
        let zoom = window.zoom();
        let point = (e.position - self.state.borrow().bounds.origin) * zoom;
        // Pixel deltas arrive in content pixels; line deltas become native pixels through `line()`.
        let delta = match e.delta {
            ScrollDelta::Pixels(delta) => delta * zoom,
            ScrollDelta::Lines(_) => e.delta.pixel_delta(px(line())),
        };
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
    pub(super) fn key(&self, key: &Keystroke, native: Option<NativeKeyData>, up: bool) {
        let Some(runtime) = self.runtime.upgrade() else {
            return;
        };
        if !up {
            self.state
                .borrow()
                .last_input
                .set(Some(std::time::Instant::now()));
        }
        let message = native.as_ref().and_then(NativeKeyData::windows).copied();
        let (windows_key_code, native_key_code) = codes(&key.key, message);
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
                // Without a key message: Windows sends Alt combinations as system keys, but not
                // AltGr, which arrives as Ctrl+Alt.
                system_key: message.map_or(key.modifiers.alt && !key.modifiers.control, |m| {
                    m.system_key
                }),
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
fn codes(key: &str, message: Option<WindowsKeyData>) -> (i32, i32) {
    if let Some(data) = message {
        return (i32::from(data.virtual_key), data.lparam as i32);
    }
    let (windows_key_code, mac) = key_codes(key);
    (windows_key_code, if super::windows() { 0 } else { mac })
}
/// No macOS key code: Chromium's invalid macOS native key code, which sets no DOM `code`.
const NO_MAC_KEY: u16 = 0xFFFF;
/// gpui's named keys: the Windows virtual key and the macOS key code.
const NAMED_KEYS: [(&str, u16, u16); 15] = [
    ("space", 0x20, 0x31),
    ("enter", 0x0D, 0x24),
    ("tab", 0x09, 0x30),
    ("backspace", 0x08, 0x33),
    ("escape", 0x1B, 0x35),
    ("delete", 0x2E, 0x75),
    ("insert", 0x2D, 0x72),
    ("home", 0x24, 0x73),
    ("end", 0x23, 0x77),
    ("pageup", 0x21, 0x74),
    ("pagedown", 0x22, 0x79),
    ("left", 0x25, 0x7B),
    ("up", 0x26, 0x7E),
    ("right", 0x27, 0x7C),
    ("down", 0x28, 0x7D),
];
/// The US layout's space and punctuation keys, by their unshifted and shifted characters: the
/// Windows virtual key (VK_OEM_*) and the macOS key code.
const PUNCTUATION_KEYS: [(&str, u16, u16); 12] = [
    (" ", 0x20, 0x31),
    ("-_", 0xBD, 0x1B),
    ("=+", 0xBB, 0x18),
    ("[{", 0xDB, 0x21),
    ("]}", 0xDD, 0x1E),
    ("\\|", 0xDC, 0x2A),
    (";:", 0xBA, 0x29),
    ("'\"", 0xDE, 0x27),
    (",<", 0xBC, 0x2B),
    (".>", 0xBE, 0x2F),
    ("/?", 0xBF, 0x2C),
    ("`~", 0xC0, 0x32),
];
/// The macOS key codes of A to Z, whose Windows virtual keys are their capital letters.
const MAC_LETTERS: [u16; 26] = [
    0x00, 0x0B, 0x08, 0x02, 0x0E, 0x03, 0x05, 0x04, 0x22, 0x26, 0x28, 0x25, 0x2E, 0x2D, 0x1F, 0x23,
    0x0C, 0x0F, 0x01, 0x11, 0x20, 0x09, 0x0D, 0x07, 0x10, 0x06,
];
/// The macOS key codes of the digits 0 to 9, whose Windows virtual keys are the digits, and the
/// US layout's shifted digit characters in the same order.
const MAC_DIGITS: [u16; 10] = [0x1D, 0x12, 0x13, 0x14, 0x15, 0x17, 0x16, 0x1A, 0x1C, 0x19];
const SHIFTED_DIGITS: &str = ")!@#$%^&*(";
/// The macOS key codes of F1 to F20; Windows has VK_F1 (0x70) to VK_F24.
const MAC_FUNCTION_KEYS: [u16; 20] = [
    0x7A, 0x78, 0x63, 0x76, 0x60, 0x61, 0x62, 0x64, 0x65, 0x6D, 0x67, 0x6F, 0x69, 0x6B, 0x71, 0x6A,
    0x40, 0x4F, 0x50, 0x5A,
];
/// The Windows virtual key and macOS key code of a gpui key: a named key, a function key or the
/// character a US-layout key types; 0 and [`NO_MAC_KEY`] for any other key.
fn key_codes(key: &str) -> (i32, i32) {
    let mut chars = key.chars();
    let single = chars.next().filter(|_| chars.next().is_none());
    let table = |(_, windows, mac): &(&str, u16, u16)| (*windows, *mac);
    let named = || NAMED_KEYS.iter().find(|(name, ..)| *name == key).map(table);
    let function = || {
        let n = key.strip_prefix('f')?.parse::<u16>().ok()?;
        let mac = MAC_FUNCTION_KEYS.get(usize::from(n.checked_sub(1)?));
        (n <= 24).then(|| (0x6F + n, mac.copied().unwrap_or(NO_MAC_KEY)))
    };
    let character = || {
        let c = single?.to_ascii_uppercase();
        let code = u16::try_from(c).ok()?;
        if c.is_ascii_uppercase() {
            return Some((code, MAC_LETTERS[usize::from(code - 0x41)]));
        }
        let digit = (SHIFTED_DIGITS.find(c))
            .or_else(|| c.to_digit(10).and_then(|d| usize::try_from(d).ok()))
            .and_then(|d| Some((0x30 + u16::try_from(d).ok()?, MAC_DIGITS[d])));
        digit.or_else(|| {
            (PUNCTUATION_KEYS.iter())
                .find(|(cs, ..)| cs.contains(c))
                .map(table)
        })
    };
    let (windows, mac) = (named().or_else(function).or_else(character)).unwrap_or((0, NO_MAC_KEY));
    (i32::from(windows), i32::from(mac))
}
