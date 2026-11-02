//! Git commands for plugin sources.
use std::{io, path::Path, process::Command};

/// A `git` command that runs in `directory`. Windows passes `core.longpaths`,
/// so files deeper than MAX_PATH work without the system-wide long path
/// setting, and starts in the directory's short-name form when its full path
/// is longer than a process may start in. [`io::ErrorKind::Unsupported`]
/// when the directory has no such form: it is too long to run git in.
/// Call off async workers: Windows may query short names.
pub fn command(directory: &Path) -> io::Result<Command> {
    let mut command = Command::new("git");
    command.current_dir(crate::command_sandbox::working_directory(directory)?);
    if cfg!(windows) {
        command.args(["-c", "core.longpaths=true"]);
    }
    Ok(command)
}
