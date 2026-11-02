//! Post-reap traversal: never enter a junction, symlink or other reparse point.
use std::{
    ffi::{OsStr, OsString},
    fs, io,
    path::{Path, PathBuf},
};
pub(super) type Directory = PathBuf;
pub(super) fn reparse(metadata: &fs::Metadata) -> bool {
    metadata.file_type().is_symlink()
}
pub(super) fn open_root(path: &Path) -> io::Result<Directory> {
    // The admitted root may itself have aliases, just as Unix's open_root does.
    // Keep the verbatim `\\?\` form: every child path joins names onto it, and
    // Win32 parsing would strip a trailing dot or space or map a device name,
    // so `sub.` or `.env ` would otherwise resolve to a different entry.
    let root = crate::secure_fs::canonicalize_extended(path)?;
    if !fs::symlink_metadata(&root)?.is_dir() {
        return Err(io::Error::other("project root is not a directory"));
    }
    Ok(root)
}
pub(super) fn open_child(parent: &Directory, name: &OsStr) -> io::Result<Directory> {
    let path = parent.join(name);
    let metadata = fs::symlink_metadata(&path)?;
    if reparse(&metadata) || !metadata.is_dir() {
        return Err(io::Error::other(
            "project directory is a reparse point or not a directory",
        ));
    }
    Ok(path)
}
pub(super) fn entries(dir: &Directory) -> io::Result<Vec<(OsString, bool)>> {
    let metadata = fs::symlink_metadata(dir)?;
    if reparse(&metadata) || !metadata.is_dir() {
        return Err(io::Error::other(
            "project directory is a reparse point or not a directory",
        ));
    }
    fs::read_dir(dir)?
        .map(|entry| {
            let entry = entry?;
            let metadata = entry.metadata()?;
            Ok((entry.file_name(), metadata.is_dir() && !reparse(&metadata)))
        })
        .collect()
}
