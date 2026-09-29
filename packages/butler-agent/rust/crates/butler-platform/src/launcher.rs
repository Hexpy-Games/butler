//! Runnable programs: marking a file executable, recognizing one, where this
//! host keeps system-wide programs, and the user's `butler` command launcher.
//!
//! Unix runs any file with an execute bit; Windows runs files by their
//! extension and has no execute bit to set.
//!
//! # The `butler` command launcher
//!
//! On Unix the launcher is `DATA/bin/butler`, a POSIX shell script that execs
//! the installation ([`cli_launcher_script`]). Windows cannot run such a
//! script, and a `.cmd` file would pass every argument through `cmd.exe`
//! quoting; its launcher is planned as a small `butler.exe` shim that the
//! Windows installer places in `DATA\bin`, next to a `butler.launcher.json`
//! naming the executable, installation root and resource root. Until that
//! installer exists there is nothing to repair, so [`cli_launcher_script`]
//! reports `None` there and Windows users run `butler-agent.exe` directly.

use std::fs::Metadata;
use std::io;
use std::path::{Path, PathBuf};

#[cfg(unix)]
mod unix;
#[cfg(unix)]
use unix as sys;
#[cfg(windows)]
mod windows;
#[cfg(windows)]
use windows as sys;

/// Makes the file at `path` runnable by name: writable by its owner and
/// executable by everyone (0755). `None` on hosts that run files by their
/// extension (Windows).
pub fn mark_executable(path: &Path) -> Option<io::Result<()>> {
    sys::mark_executable(path)
}

/// Whether the file `metadata` describes (named `path`) can be run by name: a
/// file with an execute bit on Unix; a `.exe`, `.com`, `.bat` or `.cmd` file
/// on Windows.
pub fn is_executable(path: &Path, metadata: &Metadata) -> bool {
    sys::is_executable(path, metadata)
}

/// Where this host installs system-wide programs, most specific first
/// (package managers before the system): `/opt/homebrew/bin`,
/// `/usr/local/bin` and `/usr/bin` on Unix; none on Windows, where programs
/// are found through `PATH`.
pub fn system_program_dirs() -> Vec<PathBuf> {
    sys::system_program_dirs()
}

/// Whether owner, group and others may all run the file `metadata`
/// describes: every execute bit set on Unix; any file on Windows, which has
/// no execute bits.
pub fn is_runnable_by_all(metadata: &Metadata) -> bool {
    sys::is_runnable_by_all(metadata)
}

/// What the user's `butler` command launcher runs.
#[derive(Clone, Copy, Debug)]
pub struct LauncherTarget<'a> {
    /// The DATA folder the launcher selects unless `BUTLER_DATA` is set.
    pub data_root: &'a Path,
    /// The `butler-agent` executable.
    pub executable: &'a Path,
    /// The installation root (`--installation-root`).
    pub installation_root: &'a Path,
    /// The resource root (`--resource-root`).
    pub resource_root: &'a Path,
}

/// The content of the `butler` command launcher for `target`: a POSIX shell
/// script whose second line is `marker` on Unix; `None` on Windows (see the
/// module documentation).
pub fn cli_launcher_script(target: &LauncherTarget<'_>, marker: &str) -> Option<String> {
    sys::cli_launcher_script(target, marker)
}

/// Whether this host has a `butler` command launcher for
/// [`cli_launcher_script`] to write: `true` on Unix, `false` on Windows.
pub const HAS_CLI_LAUNCHER: bool = sys::HAS_CLI_LAUNCHER;

/// This host as Node's `process.platform` names it: `darwin`, `linux`,
/// `win32` (other hosts keep Rust's name).
pub fn node_platform() -> &'static str {
    match std::env::consts::OS {
        "macos" => "darwin",
        "windows" => "win32",
        other => other,
    }
}

/// The `<os>-<arch>` tag of the release artifacts that run on this host:
/// `darwin-arm64`, `linux-x64`, `windows-x64`, ... (other architectures keep
/// Rust's name).
pub fn release_platform() -> String {
    let arch = match std::env::consts::ARCH {
        "aarch64" => "arm64",
        "x86_64" => "x64",
        other => other,
    };
    format!("{}-{arch}", sys::RELEASE_OS)
}
