//! The App's status icon and its menu, in process on every OS (Electron's foreground `Tray`):
//! macOS and Windows through `tray-icon`, Linux a StatusNotifierItem over D-Bus.
//!
//! The icon only reacts: the OS delivers clicks to the handler, which sends one message on the
//! channel. Nothing here polls or wakes the App on its own.

use std::marker::PhantomData;
use std::rc::Rc;

use tokio::sync::mpsc::UnboundedSender;

#[cfg(any(target_os = "macos", target_os = "linux", windows))]
mod pixmap;
#[cfg(target_os = "linux")]
mod sni;
#[cfg(any(target_os = "macos", windows))]
mod tray_icon;

#[cfg(target_os = "linux")]
use self::sni::Native;
#[cfg(any(target_os = "macos", windows))]
use self::tray_icon::Native;

/// A system with no tray backend: it never shows an icon.
#[cfg(not(any(target_os = "macos", target_os = "linux", windows)))]
struct Native;

#[cfg(not(any(target_os = "macos", target_os = "linux", windows)))]
impl Native {
    fn create(
        _: TrayIcon<'_>,
        _: &str,
        _: &[TrayItem],
        _: UnboundedSender<TrayEvent>,
    ) -> Result<Self, TrayError> {
        Err(TrayError::Unsupported)
    }

    fn set_menu(&self, _: &[TrayItem]) {}

    fn set_icon(&self, _: TrayIcon<'_>) {}
}

/// One menu entry.
#[derive(Clone, Debug)]
pub enum TrayItem {
    /// A command; its `id` comes back as [`TrayEvent::Item`].
    Action {
        /// Returned when the entry is chosen.
        id: String,
        /// The visible text.
        label: String,
        /// Whether it can be chosen.
        enabled: bool,
    },
    /// A checkbox; its `id` comes back as [`TrayEvent::Item`].
    Check {
        /// Returned when the entry is chosen.
        id: String,
        /// The visible text.
        label: String,
        /// Whether the box is ticked.
        checked: bool,
    },
    /// Text that cannot be chosen (the status line).
    Label(String),
    /// A divider.
    Separator,
    /// A nested menu.
    Submenu {
        /// The visible text.
        label: String,
        /// The nested entries.
        items: Vec<TrayItem>,
    },
}

/// What the user did with the icon.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum TrayEvent {
    /// A menu entry, by its id.
    Item(String),
    /// Open the App: a Windows double click, a Linux activate.
    Open,
}

/// The icon image: PNG bytes (the shell's bundled flat mark).
#[derive(Clone, Copy, Debug)]
pub struct TrayIcon<'a> {
    /// The PNG file's bytes.
    pub png: &'a [u8],
}

/// Why the icon could not be shown.
#[derive(Debug)]
pub enum TrayError {
    /// This desktop has no status area (Linux without a StatusNotifierWatcher).
    Unsupported,
    /// The OS refused; the text names the failing call.
    Failed(String),
}

/// The shown icon; dropping it removes it. Lives on the main thread.
pub struct Tray {
    native: Native,
    _main_thread: PhantomData<Rc<()>>,
}

/// Shows the icon with `tooltip` and `menu`; choices arrive on `events`.
///
/// # Errors
/// [`TrayError::Unsupported`] when the desktop has no status area, [`TrayError::Failed`] when
/// the OS refuses.
pub fn create(
    icon: TrayIcon<'_>,
    tooltip: &str,
    menu: &[TrayItem],
    events: UnboundedSender<TrayEvent>,
) -> Result<Tray, TrayError> {
    let native = Native::create(icon, tooltip, menu, events)?;
    Ok(Tray {
        native,
        _main_thread: PhantomData,
    })
}

impl Tray {
    /// Replaces the menu.
    pub fn set_menu(&self, menu: &[TrayItem]) {
        self.native.set_menu(menu);
    }

    /// Replaces the icon image (the theme changed).
    pub fn set_icon(&self, icon: TrayIcon<'_>) {
        self.native.set_icon(icon);
    }
}
