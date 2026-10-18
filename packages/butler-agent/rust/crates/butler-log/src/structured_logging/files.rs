//! Logging files inherit the platform's private-file policy.
use butler_platform::secure_fs;
use std::{
    fs::{File, OpenOptions},
    io,
    path::Path,
};

pub(super) fn create(path: &Path, exclusive: bool) -> io::Result<File> {
    let mut options = OpenOptions::new();
    options
        .write(true)
        .create(!exclusive)
        .create_new(exclusive)
        .truncate(!exclusive);
    let _ = secure_fs::owner_only(&mut options);
    let _ = secure_fs::no_follow(&mut options);
    let file = options.open(path)?;
    if let Some(result) = secure_fs::restrict_open_file(&file) {
        result?;
    }
    Ok(file)
}
pub(super) fn sync_parent(path: &Path) -> io::Result<()> {
    if let Some(parent) = path.parent()
        && let Some(result) = secure_fs::sync_directory(parent)
    {
        result?;
    }
    Ok(())
}
