//! Pure Windows sandbox planning. No host discovery or container launch occurs here.
pub mod command_line;
pub mod drive_pick;
pub mod environment;
pub mod policy;
pub mod toolchain;
mod win_path;
pub use win_path::WinPath;

/// Stable unavailable reason from a failed helper exit.
pub fn reason_code(code: u32) -> &'static str {
    match code {
        0xC000_0142 => "non_interactive_desktop",
        1314 => "privilege_not_held",
        126 | 127 => "mxc_api_missing",
        _ => "probe_failed",
    }
}
