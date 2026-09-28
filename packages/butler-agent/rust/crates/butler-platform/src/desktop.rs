//! The user's desktop: whether there is one to show a browser on, and the
//! command that opens a link in the default browser.
//!
//! macOS opens links with `open`, other Unix desktops with `xdg-open`, and
//! Windows with the URL protocol handler (`rundll32 url.dll,
//! FileProtocolHandler`), which takes the link as one argument and never
//! passes it through `cmd.exe`, so `&` and `^` in a query string stay intact.

use std::process::Command;

/// Whether this session has a desktop a browser can open on. Linux needs a
/// display server (`DISPLAY` or `WAYLAND_DISPLAY`) or WSL, whose Windows side
/// opens links; macOS and Windows sessions always have one.
pub fn has_display() -> bool {
    if !cfg!(target_os = "linux") {
        return true;
    }
    ["DISPLAY", "WAYLAND_DISPLAY", "WSL_DISTRO_NAME"]
        .iter()
        .any(|name| std::env::var_os(name).is_some_and(|value| !value.is_empty()))
}

/// The command that opens `url` in the default browser. It exits once the
/// link is handed over; its status says whether that worked.
pub fn open_url(url: &str) -> Command {
    let mut command = if cfg!(target_os = "macos") {
        Command::new("open")
    } else if cfg!(windows) {
        let mut command = Command::new("rundll32.exe");
        command.arg("url.dll,FileProtocolHandler");
        command
    } else {
        Command::new("xdg-open")
    };
    command.arg(url);
    command
}
