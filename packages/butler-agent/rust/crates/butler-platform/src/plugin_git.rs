//! Git commands for plugin sources.
use std::{path::Path, process::Command};

/// Git opens the repository's own `.git\config` before it applies `-c`
/// options, so without the system-wide long path setting Windows git opens
/// only repositories whose config stays within MAX_PATH (259 units and the
/// NUL). Git also resolves short-name folders to their full form, so no
/// shorter spelling helps.
const LONGEST_REPOSITORY: usize = 259 - "\\.git\\config".len();

/// A `git` command that runs in `directory`. Windows passes `core.longpaths`,
/// so files deeper than MAX_PATH check out without the system-wide setting
/// once git has read the repository's config.
pub fn command(directory: &Path) -> Command {
    let mut command = Command::new("git");
    command.current_dir(directory);
    if cfg!(windows) {
        command.args(["-c", "core.longpaths=true"]);
    }
    command
}

/// Whether git can open a repository in `directory` without the system-wide
/// long path setting: false on Windows when its `.git\config` would pass
/// MAX_PATH.
pub fn within_reach(directory: &Path) -> bool {
    !cfg!(windows)
        || directory
            .as_os_str()
            .to_string_lossy()
            .encode_utf16()
            .count()
            <= LONGEST_REPOSITORY
}
