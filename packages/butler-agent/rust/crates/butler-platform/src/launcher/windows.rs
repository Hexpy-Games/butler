//! Windows runs files by their extension; there are no execute bits.

use std::fs::Metadata;
use std::io;
use std::path::{Path, PathBuf};

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

pub(super) fn system_program_dirs() -> Vec<PathBuf> {
    Vec::new()
}
