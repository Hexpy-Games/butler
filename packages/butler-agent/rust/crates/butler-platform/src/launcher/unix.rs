//! Execute permission bits and the conventional program directories.

use std::fs::{self, Metadata};
use std::io;
use std::os::unix::fs::PermissionsExt;
use std::path::{Path, PathBuf};

use super::LauncherTarget;

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

pub(super) fn is_runnable_by_all(metadata: &Metadata) -> bool {
    metadata.permissions().mode() & EXECUTE_BITS == EXECUTE_BITS
}

pub(super) fn cli_launcher_script(target: &LauncherTarget<'_>, marker: &str) -> Option<String> {
    Some(format!(
        "#!/bin/sh\n{marker}\n# Managed by Butler: rewritten when the Butler service starts.\n\
         BUTLER_DATA=\"${{BUTLER_DATA:-{data}}}\"\nexport BUTLER_DATA\n\
         exec {binary} --installation-root {root} --resource-root {resources} \"$@\"\n",
        data = double_quoted(target.data_root),
        binary = single_quoted(target.executable),
        root = single_quoted(target.installation_root),
        resources = single_quoted(target.resource_root),
    ))
}

fn single_quoted(path: &Path) -> String {
    format!("'{}'", path.to_string_lossy().replace('\'', "'\\''"))
}

/// Escapes a path for use inside `"..."` in a POSIX shell.
fn double_quoted(path: &Path) -> String {
    let mut out = String::new();
    for character in path.to_string_lossy().chars() {
        if matches!(character, '"' | '\\' | '$' | '`') {
            out.push('\\');
        }
        out.push(character);
    }
    out
}

pub(super) fn system_program_dirs() -> Vec<PathBuf> {
    ["/opt/homebrew/bin", "/usr/local/bin", "/usr/bin"]
        .into_iter()
        .map(PathBuf::from)
        .collect()
}
