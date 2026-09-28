//! Windows runs files by their extension; there are no execute bits.

use std::fs::Metadata;
use std::io;
use std::path::{Path, PathBuf};

use super::LauncherTarget;

pub(super) const RELEASE_OS: &str = "windows";

const RUNNABLE_EXTENSIONS: [&str; 4] = ["exe", "com", "bat", "cmd"];

pub(super) fn mark_executable(_path: &Path) -> Option<io::Result<()>> {
    None
}

pub(super) fn is_executable(path: &Path, metadata: &Metadata) -> bool {
    metadata.is_file()
        && path.extension().is_some_and(|extension| {
            RUNNABLE_EXTENSIONS
                .iter()
                .any(|runnable| extension.eq_ignore_ascii_case(runnable))
        })
}

pub(super) fn is_runnable_by_all(_metadata: &Metadata) -> bool {
    true
}

/// The `butler.exe` shim is not installed yet (see the module documentation).
pub(super) fn cli_launcher_script(_target: &LauncherTarget<'_>, _marker: &str) -> Option<String> {
    None
}

pub(super) fn system_program_dirs() -> Vec<PathBuf> {
    Vec::new()
}
