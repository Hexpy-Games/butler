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
        count_sync();
    }
    Ok(())
}

#[cfg(feature = "e2e-fixtures")]
thread_local! { static SYNCS: std::cell::Cell<usize> = const { std::cell::Cell::new(0) }; }
fn count_sync() {
    #[cfg(feature = "e2e-fixtures")]
    SYNCS.set(SYNCS.get() + 1);
}
pub(super) fn sync(file: &File) -> io::Result<()> {
    file.sync_all()?;
    count_sync();
    Ok(())
}
#[cfg(feature = "e2e-fixtures")]
pub(super) fn sync_count() -> usize {
    SYNCS.get()
}
