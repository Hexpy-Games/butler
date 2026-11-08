//! Opening the App at login (Electron `setLoginItemSettings`): macOS `SMAppService`, Windows
//! the per-user Run key, Linux unavailable. Only a packaged App
//! ([`crate::app_shell::shell_registration_allowed`]) registers.
use std::path::Path;

#[cfg(target_os = "macos")]
mod mac;
#[cfg(windows)]
mod windows;

/// Whether the App opens at login.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum LoginItem {
    /// Registered for this executable.
    On,
    /// Not registered.
    Off,
    /// This build or OS cannot register (the setting is hidden).
    Unavailable,
}

/// Why the registration could not change.
#[derive(Debug)]
pub enum LoginItemError {
    /// This build or OS cannot register.
    Unsupported,
    /// The OS refused; the text names the failing call, never a path or secret.
    Failed(String),
}

/// Whether `executable` opens at login.
pub fn status(executable: &Path) -> LoginItem {
    if !crate::app_shell::shell_registration_allowed(executable) {
        return LoginItem::Unavailable;
    }
    #[cfg(target_os = "macos")]
    let on = Some(mac::enabled());
    #[cfg(windows)]
    let on = Some(windows::enabled(executable));
    #[cfg(not(any(target_os = "macos", windows)))]
    let on: Option<bool> = None;
    match on {
        Some(true) => LoginItem::On,
        Some(false) => LoginItem::Off,
        None => LoginItem::Unavailable,
    }
}

/// Registers (`open_at_login`) or removes `executable` as a login item.
pub fn set(executable: &Path, open_at_login: bool) -> Result<(), LoginItemError> {
    if status(executable) == LoginItem::Unavailable {
        return Err(LoginItemError::Unsupported);
    }
    #[cfg(target_os = "macos")]
    return mac::set(open_at_login);
    #[cfg(windows)]
    return windows::set(executable, open_at_login);
    #[cfg(not(any(target_os = "macos", windows)))]
    {
        let _ = open_at_login;
        Err(LoginItemError::Unsupported)
    }
}
