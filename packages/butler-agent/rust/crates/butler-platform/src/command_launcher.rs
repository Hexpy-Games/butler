//! The user's `butler` command: the small launcher file that runs the
//! installed Agent.
//!
//! A launcher is a POSIX shell script on Unix and a `.cmd` file on Windows.
//! Its second line is a marker naming it Butler's, and the marker decides
//! ownership: only a file with the marker (or the stale pre-native launcher)
//! is ever rewritten or removed, and every other file at the path is the
//! user's and is left alone.

use std::fs;
use std::io::{self, Write};
use std::path::{Path, PathBuf};

use crate::{launcher, user_dirs};

#[cfg(unix)]
mod unix;
#[cfg(unix)]
use unix as sys;
#[cfg(windows)]
mod windows;
#[cfg(windows)]
use windows as sys;

/// The entrypoint the pre-native Bun launcher runs; the compiled launcher
/// embeds its name.
const STALE_ENTRYPOINT: &[u8] = b"butler.js";

/// What a launcher runs.
#[derive(Clone, Copy, Debug)]
pub struct Target<'a> {
    /// The Agent executable to run.
    pub program: &'a Path,
    /// Passed as `--installation-root`.
    pub installation_root: &'a Path,
    /// Passed as `--resource-root`.
    pub resource_root: &'a Path,
    /// The data folder the launcher selects when the caller names none.
    pub data_default: Option<&'a Path>,
}

/// Who a file at a launcher path belongs to.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Ownership {
    /// Butler's current launcher format (it carries the marker).
    Ours,
    /// The pre-native Bun launcher, which Butler replaces.
    Stale,
    /// The user's own file, or a symbolic link: never touched.
    Foreign,
}

/// What [`remove_if_ours`] did.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Removal {
    /// The launcher was Butler's and is gone.
    Removed,
    /// Nothing was at the path.
    Absent,
    /// The file is the user's and stays.
    Kept,
}

/// The launcher script that runs `target`.
pub fn render(target: &Target<'_>) -> String {
    sys::render(target)
}

/// The launcher's file name: `butler` on Unix, `butler.cmd` on Windows.
pub fn file_name() -> &'static str {
    sys::FILE_NAME
}

/// Where the user's `butler` command lives (`~/.local/bin/butler` on Unix);
/// `None` without a home directory.
pub fn default_path() -> Option<PathBuf> {
    Some(user_dirs::command_dir()?.join(sys::FILE_NAME))
}

/// Whose launcher `contents` are.
pub fn classify(contents: &[u8]) -> Ownership {
    let marker_line = contents
        .split(|byte| *byte == b'\n')
        .nth(1)
        .map(|line| line.strip_suffix(b"\r").unwrap_or(line));
    if marker_line.is_some_and(|line| line == sys::MARKER_LINE.as_bytes()) {
        Ownership::Ours
    } else if contents
        .windows(STALE_ENTRYPOINT.len())
        .any(|window| window == STALE_ENTRYPOINT)
    {
        Ownership::Stale
    } else {
        Ownership::Foreign
    }
}

/// Whose file is at `path`; `None` when nothing is there. A symbolic link is
/// the user's, whatever it points to.
///
/// # Errors
///
/// The failure to inspect or read the file.
pub fn ownership(path: &Path) -> io::Result<Option<Ownership>> {
    match fs::symlink_metadata(path) {
        Ok(metadata) if metadata.file_type().is_file() => {}
        Ok(_) => return Ok(Some(Ownership::Foreign)),
        Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(None),
        Err(error) => return Err(error),
    }
    Ok(Some(classify(&fs::read(path)?)))
}

/// Whether the file at `path` holds exactly `wanted` and can be run.
pub fn is_current(path: &Path, wanted: &str) -> bool {
    let Ok(metadata) = fs::symlink_metadata(path) else {
        return false;
    };
    metadata.file_type().is_file()
        && launcher::is_executable(path, &metadata)
        && fs::read(path).is_ok_and(|contents| contents == wanted.as_bytes())
}

/// Atomically replaces the file at `path` with a runnable launcher holding
/// `contents`, creating the directory when needed. The caller checked
/// [`ownership`] first; this never looks at what it replaces.
///
/// # Errors
///
/// The failure to write, mark or rename the file; the temporary file is
/// removed then.
pub fn write(path: &Path, contents: &str) -> io::Result<()> {
    let parent = path
        .parent()
        .filter(|parent| !parent.as_os_str().is_empty())
        .unwrap_or(Path::new("."));
    fs::create_dir_all(parent)?;
    let staging = parent.join(format!(".butler.launcher-{}", std::process::id()));
    let result = write_runnable(&staging, contents).and_then(|()| fs::rename(&staging, path));
    if result.is_err() {
        let _ = fs::remove_file(&staging);
    }
    result
}

fn write_runnable(path: &Path, contents: &str) -> io::Result<()> {
    let mut file = fs::File::create(path)?;
    file.write_all(contents.as_bytes())?;
    file.sync_all()?;
    launcher::mark_executable(path).unwrap_or(Ok(()))
}

/// Moves the stale launcher at `path` to `butler.previous` beside it, unless
/// one is kept already (then the stale launcher is simply replaced later).
///
/// # Errors
///
/// The failure to inspect or rename the file.
pub fn keep_previous(path: &Path) -> io::Result<()> {
    let previous = path.with_file_name(format!("{}.previous", sys::FILE_NAME));
    match fs::symlink_metadata(&previous) {
        Ok(_) => Ok(()),
        Err(error) if error.kind() == io::ErrorKind::NotFound => fs::rename(path, previous),
        Err(error) => Err(error),
    }
}

/// Removes the launcher at `path` when it carries Butler's marker; any other
/// file (including the stale pre-native launcher) stays.
///
/// # Errors
///
/// The failure to inspect, read or remove the file.
pub fn remove_if_ours(path: &Path) -> io::Result<Removal> {
    match ownership(path)? {
        None => Ok(Removal::Absent),
        Some(Ownership::Foreign | Ownership::Stale) => Ok(Removal::Kept),
        Some(Ownership::Ours) => {
            fs::remove_file(path)?;
            Ok(Removal::Removed)
        }
    }
}
