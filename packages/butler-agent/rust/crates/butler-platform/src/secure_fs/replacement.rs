//! Durable private-file publication, with a staging file owned by this call.
use super::{
    OWNER_ONLY, owner_only, rename, restrict_file, sync_directory, timing, unique_temporary,
};
use std::{
    fs::{self, File, OpenOptions},
    io,
    path::Path,
};

/// Atomically replaces `path` with a private file: Unix creation modes or
/// Windows ACLs restrict the empty staging file before `write` fills it. The
/// temporary file next to `path` is synced, renamed over `path`, and the rename is synced where
/// [`super::DIRECTORY_SYNC`]. On failure before the rename, the temporary file is
/// removed and `path` is untouched; an entry this call did not create is
/// never removed. `write` reports its own errors; `io_error` converts the
/// I/O failures of creating, syncing and renaming.
pub fn replace_private<E>(
    path: &Path,
    write: impl FnOnce(&mut File) -> Result<(), E>,
    io_error: impl Fn(io::Error) -> E,
) -> Result<(), E> {
    let timing = timing::Timing::new();
    let parent = path
        .parent()
        .filter(|parent| !parent.as_os_str().is_empty())
        .unwrap_or(Path::new("."));
    let temporary = unique_temporary(path);
    let mut options = OpenOptions::new();
    options.write(true).create_new(true);
    let _ = owner_only(&mut options);
    let mut file = options.open(&temporary).map_err(&io_error)?;
    timing.mark("created");
    // On ACL hosts an existing parent may still have explicit broad ACEs.
    // Restrict the empty staging file before any secret content is written.
    let private = if OWNER_ONLY {
        Ok(())
    } else {
        restrict_file(&temporary)
            .unwrap_or(Ok(()))
            .map_err(&io_error)
    };
    let written = private.and_then(|()| write(&mut file)).and_then(|()| {
        timing.mark("written");
        file.sync_all().map_err(&io_error)?;
        timing.mark("synced");
        drop(file);
        rename(&temporary, path).map_err(&io_error)?;
        timing.mark("renamed");
        Ok(())
    });
    if let Err(error) = written {
        let _ = fs::remove_file(&temporary);
        return Err(error);
    }
    sync_directory(parent).unwrap_or(Ok(())).map_err(io_error)
}
