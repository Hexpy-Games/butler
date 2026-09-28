//! The user's `butler` command in `DATA/bin`, and runnable files in general.
//!
//! On Unix the launcher is a `#!/bin/sh` script that execs the running
//! installation. On Windows a script cannot be run by name, so it becomes a
//! small `butler.exe` shim that reads `butler.launcher.json` next to it and
//! starts the installation it names.
//!
//! The launcher itself is an interface only: the agent's launcher repair
//! still writes the Unix script until the launcher moves here.

use std::fs::Metadata;
use std::io;
use std::path::Path;

#[cfg(unix)]
mod unix;
#[cfg(unix)]
use unix as sys;
#[cfg(windows)]
mod windows;
#[cfg(windows)]
use windows as sys;

/// How the `butler` command is installed on this host.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum LauncherKind {
    /// A `#!/bin/sh` script marked executable.
    ShellScript,
    /// A copied shim executable plus its `butler.launcher.json`.
    ExecutableShim,
}

/// This host's launcher.
pub const KIND: LauncherKind = if cfg!(windows) {
    LauncherKind::ExecutableShim
} else {
    LauncherKind::ShellScript
};

/// The launcher's file name in `DATA/bin`.
pub const FILE_NAME: &str = if cfg!(windows) {
    "butler.exe"
} else {
    "butler"
};

/// The file next to the Windows shim that names the installation it starts.
pub const SHIM_CONFIGURATION: &str = "butler.launcher.json";

/// Makes the file at `path` runnable by name: writable by its owner and
/// executable by everyone (0755) on Unix. Windows runs files by their
/// extension and changes nothing.
pub fn mark_executable(path: &Path) -> io::Result<()> {
    sys::mark_executable(path)
}

/// Whether the file `metadata` describes can be run by name: a file with an
/// execute bit on Unix, any file on Windows.
pub fn is_executable(metadata: &Metadata) -> bool {
    sys::is_executable(metadata)
}
