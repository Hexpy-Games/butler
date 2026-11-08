//! What the App can say about OS notifications (Electron `main.mjs` notification status): whether
//! this build can post them, the status details code and the OS settings page. Posting itself
//! goes through gpui.
use std::path::Path;

/// Whether this build can post OS notifications.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum NotificationSupport {
    /// It can post.
    Supported,
    /// It cannot (outside an app bundle, no installed shortcut, no session bus).
    Unsupported,
}

/// Whether `executable` can post OS notifications. macOS: it runs inside a `.app` bundle.
/// Windows: toasts need the installed shortcut, so registration must be allowed
/// ([`crate::app_shell::shell_registration_allowed`]). Linux: a session D-Bus exists.
pub fn support(executable: &Path) -> NotificationSupport {
    if can_post(executable) {
        NotificationSupport::Supported
    } else {
        NotificationSupport::Unsupported
    }
}

#[cfg(target_os = "macos")]
fn can_post(executable: &Path) -> bool {
    crate::app_shell::installation_root(executable).is_some()
}

#[cfg(target_os = "windows")]
fn can_post(executable: &Path) -> bool {
    crate::app_shell::shell_registration_allowed(executable)
}

#[cfg(not(any(target_os = "macos", target_os = "windows")))]
fn can_post(_executable: &Path) -> bool {
    std::env::var_os("DBUS_SESSION_BUS_ADDRESS").is_some_and(|address| !address.is_empty())
        || std::env::var_os("XDG_RUNTIME_DIR")
            .is_some_and(|dir| Path::new(&dir).join("bus").exists())
}

/// The status details code: `macos-permission`, `windows-shortcut` or `linux-libnotify`.
pub fn details_code() -> &'static str {
    if cfg!(target_os = "macos") {
        "macos-permission"
    } else if cfg!(target_os = "windows") {
        "windows-shortcut"
    } else {
        "linux-libnotify"
    }
}

/// The OS notification settings page, where the OS has one.
pub fn settings_url() -> Option<&'static str> {
    if cfg!(target_os = "macos") {
        Some("x-apple.systempreferences:com.apple.Notifications-Settings.extension")
    } else if cfg!(target_os = "windows") {
        Some("ms-settings:notifications")
    } else {
        None
    }
}
