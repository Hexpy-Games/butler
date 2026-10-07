//! Exact leaf spelling without enumerating the project directory.
use std::{io, path::Path};

/// Case-insensitive filesystems must not admit differently spelled instructions.
/// Inspect the entry itself, including symlinks; the contained reader rejects
/// links and nonregular files separately before reading their contents.
pub fn exact_entry_exists(path: &Path) -> io::Result<bool> {
    match exact(path) {
        Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(false),
        result => result,
    }
}

#[cfg(target_os = "macos")]
fn exact(path: &Path) -> io::Result<bool> {
    use rustix::fs::{Mode, OFlags, getpath, open};
    use std::os::unix::ffi::OsStrExt;
    let entry = open(
        path,
        OFlags::RDONLY | OFlags::SYMLINK | OFlags::NONBLOCK | OFlags::CLOEXEC,
        Mode::empty(),
    )?;
    let actual = getpath(&entry)?;
    Ok(Path::new(std::ffi::OsStr::from_bytes(actual.as_bytes())).file_name() == path.file_name())
}

#[cfg(not(target_os = "macos"))]
fn exact(path: &Path) -> io::Result<bool> {
    std::fs::symlink_metadata(path).map(|_| true)
}
