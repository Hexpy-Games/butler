//! Runnable programs: marking a file executable, recognizing one, and where
//! this host keeps system-wide programs.
//!
//! Unix runs any file with an execute bit; Windows runs files by their
//! extension and has no execute bit to set. The user's `butler` command
//! launcher moves here in a later stage.

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
