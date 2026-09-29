//! The named pointers of an Agent home (`current`, `previous`): each names
//! one version directory of the home and is switched atomically.
//!
//! Unix keeps a relative symbolic link, replaced by renaming a fresh link
//! over the old one, so a reader sees the old or the new version and never
//! neither. Windows keeps a small pointer file, replaced atomically the same
//! way, because creating links there needs a privilege. Callers only name a
//! version directory (a plain file name) and read the name back.

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

/// Makes the pointer `link` of `home` name the version directory `target`
/// (a plain file name inside `home`), replacing what it named before.
///
/// # Errors
///
/// `InvalidInput` when `link` or `target` is not a plain file name; otherwise
/// the failure of creating or renaming the pointer, including an existing
/// `link` that is a real file or directory instead of a pointer.
pub fn point(home: &Path, link: &str, target: &str) -> io::Result<()> {
    require_plain_name(link)?;
    require_plain_name(target)?;
    sys::point(home, link, target)
}

/// The version directory name the pointer `link` of `home` names; `None`
/// when there is no pointer.
///
/// # Errors
///
/// `InvalidData` when `link` exists but is not a pointer this module wrote
/// (a real directory, or a target that is not a plain file name).
pub fn read(home: &Path, link: &str) -> io::Result<Option<String>> {
    require_plain_name(link)?;
    sys::read(home, link)
}

/// Removes the pointer `link` of `home` (never what it names). A missing
/// pointer is not an error.
///
/// # Errors
///
/// `InvalidData` when `link` is a real file or directory, so a directory the
/// user put there is never removed; otherwise the removal failure.
pub fn remove(home: &Path, link: &str) -> io::Result<()> {
    require_plain_name(link)?;
    sys::remove(home, link)
}

/// Whether `name` is one ordinary path component: not empty, not `.` or
/// `..`, and with no separator.
pub fn is_plain_name(name: &str) -> bool {
    !name.is_empty()
        && name != "."
        && name != ".."
        && !name.contains(['/', '\\', '\0', ':'])
        && Path::new(name).components().count() == 1
}

fn require_plain_name(name: &str) -> io::Result<()> {
    if is_plain_name(name) {
        Ok(())
    } else {
        Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            "a pointer name must be a plain file name",
        ))
    }
}

fn not_a_pointer() -> io::Error {
    io::Error::new(
        io::ErrorKind::InvalidData,
        "the path exists but is not a version pointer",
    )
}
