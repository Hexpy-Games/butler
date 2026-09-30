//! The operating system's language preference, without an English fallback.

/// Returns the process locale, or the desktop locale where the OS exposes it.
/// Unknown, C and POSIX locales leave first-install policy to the caller.
pub fn system_locale() -> Option<String> {
    for key in ["LC_ALL", "LC_MESSAGES", "LANG"] {
        if let Ok(value) = std::env::var(key)
            && !value.trim().is_empty()
        {
            return known_locale(&value);
        }
    }
    desktop_locale().and_then(|value| known_locale(&value))
}

fn known_locale(value: &str) -> Option<String> {
    let value = value.trim().split(['.', '@']).next()?;
    (!matches!(value, "" | "C" | "POSIX")).then(|| value.replace('_', "-"))
}

#[cfg(target_os = "macos")]
fn desktop_locale() -> Option<String> {
    let output = std::process::Command::new("defaults")
        .args(["read", "-g", "AppleLocale"])
        .output()
        .ok()?;
    output
        .status
        .success()
        .then(|| String::from_utf8_lossy(&output.stdout).into_owned())
}

#[cfg(windows)]
fn desktop_locale() -> Option<String> {
    let output = std::process::Command::new("powershell.exe")
        .args([
            "-NoProfile",
            "-NonInteractive",
            "-Command",
            "(Get-Culture).Name",
        ])
        .output()
        .ok()?;
    output
        .status
        .success()
        .then(|| String::from_utf8_lossy(&output.stdout).into_owned())
}

#[cfg(not(any(target_os = "macos", windows)))]
fn desktop_locale() -> Option<String> {
    None
}
