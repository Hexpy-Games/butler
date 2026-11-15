use std::{fmt, path::PathBuf};

#[derive(Clone)]
pub enum OsrProfile {
    SignedIn,
    SignedOut(String),
}

pub struct OsrConfig {
    /// macOS: absolute path to Chromium Embedded Framework.framework.
    /// Windows: the CEF runtime directory (resources, `locales`). libcef.dll itself is linked at
    /// load time, so it must also be on the process's DLL search path (beside the executable).
    pub framework_dir: PathBuf,
    /// The CEF subprocess executable. macOS: the staged `butler-cef-host Helper`;
    /// Windows: the staged `butler_cef_host.exe` (CEF's bootstrapc.exe, see stage.py).
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
    History {
        can_back: bool,
        can_forward: bool,
    },
    PopupNewTab {
        url: String,
    },
    PopupBlocked {
        url: String,
        reason: PopupBlock,
    },
    PopupOpened {
        child: u64,
        url: String,
    },
    CloseRequested,
    Dialog(OsrDialog),
    DownloadStarted {
        id: u32,
        suggested_name: String,
        total_bytes: u64,
    },
    DownloadProgress {
        id: u32,
        received: u64,
        total: u64,
    },
    DownloadDone {
        id: u32,
        completed: bool,
    },
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

#[cfg(cef_osr)]
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

#[cfg(cef_osr)]
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
    /// The platform key code: macOS, the virtual key code; Windows, the `WM_KEYDOWN` lParam
    /// (scan code in bits 16..24, extended-key flag in bit 24), which sets the DOM `code`.
    pub native_key_code: i32,
    /// The Windows virtual key code (CEF requires it on every platform).
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

/// Synchronous UI-thread popup policy. No UI toolkit state crosses this boundary.
pub type PopupPolicy = std::rc::Rc<dyn Fn(&PopupRequest) -> PopupDecision>;
pub struct PopupRequest {
    pub opener: u64,
    pub url: String,
    pub disposition: PopupDisposition,
    pub user_gesture: bool,
}
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum PopupDisposition {
    NewTab,
    NewWindow,
    NewPopup,
    Other,
}
pub enum PopupDecision {
    NewTab,
    Block(PopupBlock),
    Allow { child: u64 },
}
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum PopupBlock {
    NoGesture,
    TabBudget,
}
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum OsrDialogKind {
    Alert,
    Confirm,
    Prompt,
    BeforeUnload,
    Auth,
    File,
}
#[derive(Clone, Debug)]
pub struct OsrDialog {
    pub id: u64,
    pub kind: OsrDialogKind,
    pub message: String,
    pub default_prompt: String,
    pub origin: String,
    pub accept_types: Vec<String>,
    pub multiple: bool,
}
#[derive(Default)]
pub struct OsrAnswer {
    pub accept: bool,
    pub text: String,
    pub username: String,
    pub password: String,
    pub files: Vec<PathBuf>,
}

/// Synchronous download destination policy; no toolkit state crosses this boundary.
pub type DownloadPolicy = std::rc::Rc<dyn Fn(&DownloadRequest) -> DownloadDecision>;
pub struct DownloadRequest {
    pub page: u64,
    pub id: u32,
    pub suggested_name: String,
    pub total_bytes: u64,
}
pub enum DownloadDecision {
    Dialog,
    Stage(PathBuf),
}
