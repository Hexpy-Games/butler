//! Execute permission bits and the conventional program directories.

use std::fs::{self, Metadata};
use std::io;
use std::os::unix::fs::PermissionsExt;
use std::path::{Path, PathBuf};

/// Release artifacts name macOS `darwin`; other Unix hosts by Rust's name.
pub(super) const RELEASE_OS: &str = if cfg!(target_os = "macos") {
    "darwin"
} else {
    std::env::consts::OS
};

const EXECUTABLE: u32 = 0o755;
const EXECUTE_BITS: u32 = 0o111;

pub(super) fn mark_executable(path: &Path) -> Option<io::Result<()>> {
    Some(fs::set_permissions(
        path,
        fs::Permissions::from_mode(EXECUTABLE),
    ))
}

pub(super) fn is_executable(_path: &Path, metadata: &Metadata) -> bool {
    metadata.is_file() && metadata.permissions().mode() & EXECUTE_BITS != 0
}

pub(super) fn system_program_dirs() -> Vec<PathBuf> {
    ["/opt/homebrew/bin", "/usr/local/bin", "/usr/bin"]
        .into_iter()
        .map(PathBuf::from)
        .collect()
}
