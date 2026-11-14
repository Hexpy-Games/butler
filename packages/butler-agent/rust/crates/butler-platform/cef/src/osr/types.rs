use std::{fmt, path::PathBuf};

pub struct OsrConfig {
    /// Absolute path to Chromium Embedded Framework.framework.
    pub framework_dir: PathBuf,
    pub helper_path: PathBuf,
    pub profile_dir: PathBuf,
    pub locale: String,
    /// Full User-Agent string, built by the caller.
    pub user_agent: String,
}

#[derive(Debug)]
pub enum OsrEvent {
    Url(String),
    Title(String),
    Favicon(String),
    Loading(bool),
    History { can_back: bool, can_forward: bool },
    Crashed,
    Frame,
    Cursor(OsrCursor),
    ImeBounds(Vec<Rect>),
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct Rect {
    pub x: i32,
    pub y: i32,
    pub width: i32,
    pub height: i32,
}

impl From<&cef::Rect> for Rect {
    fn from(rect: &cef::Rect) -> Self {
        Self {
            x: rect.x,
            y: rect.y,
            width: rect.width,
            height: rect.height,
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum OsrCursor {
    Arrow,
    PointingHand,
    IBeam,
}

#[derive(Clone, Copy, Debug, Default)]
#[expect(
    clippy::struct_excessive_bools,
    reason = "independent keyboard modifier flags"
)]
pub struct OsrModifiers {
    pub shift: bool,
    pub control: bool,
    pub alt: bool,
    pub command: bool,
}

impl OsrModifiers {
    pub(super) fn flags(self) -> u32 {
        (u32::from(self.shift) * 2)
            | (u32::from(self.control) * 4)
            | (u32::from(self.alt) * 8)
            | (u32::from(self.command) * 128)
    }
}

#[derive(Clone, Copy, Debug)]
pub enum OsrButton {
    Left,
    Middle,
    Right,
}

impl OsrButton {
    pub(super) fn cef(self) -> cef::MouseButtonType {
        match self {
            Self::Left => cef::MouseButtonType::LEFT,
            Self::Middle => cef::MouseButtonType::MIDDLE,
            Self::Right => cef::MouseButtonType::RIGHT,
        }
    }
    pub(super) fn flag(self) -> u32 {
        match self {
            Self::Left => 16,
            Self::Middle => 32,
            Self::Right => 64,
        }
    }
}

#[derive(Clone, Copy, Debug)]
pub enum OsrMouseKind {
    Move,
    Leave,
    Down,
    Up,
}

#[derive(Clone, Copy, Debug)]
pub struct OsrMouse {
    pub x: i32,
    pub y: i32,
    pub modifiers: OsrModifiers,
    pub kind: OsrMouseKind,
    pub button: Option<OsrButton>,
    pub click_count: i32,
}

#[derive(Clone, Copy, Debug)]
pub struct OsrWheel {
    pub x: i32,
    pub y: i32,
    pub modifiers: OsrModifiers,
    pub delta_x: i32,
    pub delta_y: i32,
}

#[derive(Clone, Copy, Debug)]
pub struct OsrKey {
    /// The macOS virtual key code and Windows virtual key code (CEF requires both).
    pub native_key_code: i32,
    pub windows_key_code: i32,
    pub character: u16,
    pub unmodified_character: u16,
    pub modifiers: OsrModifiers,
    pub up: bool,
}

#[derive(Debug)]
pub struct OsrError(pub(super) String);
impl fmt::Display for OsrError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(&self.0)
    }
}
impl std::error::Error for OsrError {}
