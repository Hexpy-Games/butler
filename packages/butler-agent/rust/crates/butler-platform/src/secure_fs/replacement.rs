//! Durable private-file publication, with a staging file owned by this call.
use super::{
    OWNER_ONLY, owner_only, rename, restrict_file, sync_directory, timing, unique_temporary,
};
use std::{
    fs::{self, File, OpenOptions},
    io,
    path::{Path, PathBuf},
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
    stage_private(path, write, &io_error, true)?
        .commit()
        .and_then(Committed::sync)
        .map_err(io_error)
}

/// Atomically publishes a private, reconstructible copy without explicit file
/// or directory synchronization. Platform rename guarantees still apply.
/// The caller must already hold a durable source and recover this
/// copy if it is missing or incomplete after a crash. Never use for acceptance
/// of new user data or for a source of truth.
pub fn replace_private_reconstructible<E>(
    path: &Path,
    write: impl FnOnce(&mut File) -> Result<(), E>,
    io_error: impl Fn(io::Error) -> E,
) -> Result<(), E> {
    stage_private(path, write, &io_error, false)?
        .commit()
        .and_then(Committed::sync)
        .map_err(io_error)
}

/// A complete private file next to its destination, not yet visible there.
/// Staging, the slow part of a replacement, needs no lock that orders
/// publications: only [`StagedFile::commit`] changes the destination.
/// Dropping an uncommitted file removes it.
#[must_use = "a staged file is removed unless committed"]
pub struct StagedFile {
    temporary: PathBuf,
    path: PathBuf,
    durable: bool,
    committed: bool,
    timing: Option<timing::Timing>,
}

/// A rename that is visible but, for a durable file, not yet synced to storage.
#[must_use = "a durable publication is complete only after sync"]
pub struct Committed {
    parent: PathBuf,
    durable: bool,
    _timing: Option<timing::Timing>,
}

/// Creates the private staging file for `path` and fills it with `write`.
/// A `durable` file is synced before this returns; [`Committed::sync`] then
/// syncs the directory after the rename. A file that is not durable is a
/// reconstructible copy (see [`replace_private_reconstructible`]).
pub fn stage_private<E>(
    path: &Path,
    write: impl FnOnce(&mut File) -> Result<(), E>,
    io_error: impl Fn(io::Error) -> E,
    durable: bool,
) -> Result<StagedFile, E> {
    #[cfg(feature = "test-support")]
    if !durable {
        super::hold_point("reconstructible_file_publish", || false).map_err(&io_error)?;
    }
    let timing = timing::Timing::new();
    let temporary = unique_temporary(path);
    let mut options = OpenOptions::new();
    options.write(true).create_new(true);
    let _ = owner_only(&mut options);
    let mut file = options.open(&temporary).map_err(&io_error)?;
    timing.mark("created");
    let staged = StagedFile {
        temporary,
        path: path.to_owned(),
        durable,
        committed: false,
        timing: Some(timing),
    };
    let filled = staged.fill(&mut file, write, &io_error);
    // Closed before an error drops (removes) it or a commit renames it.
    drop(file);
    filled.map(|()| staged)
}

impl StagedFile {
    fn fill<E>(
        &self,
        file: &mut File,
        write: impl FnOnce(&mut File) -> Result<(), E>,
        io_error: impl Fn(io::Error) -> E,
    ) -> Result<(), E> {
        // On ACL hosts an existing parent may still have explicit broad ACEs.
        // Restrict the empty staging file before any secret content is written.
        if !OWNER_ONLY {
            restrict_file(&self.temporary)
                .unwrap_or(Ok(()))
                .map_err(&io_error)?;
        }
        write(file)?;
        self.mark("written");
        if self.durable {
            file.sync_all().map_err(&io_error)?;
            self.mark("synced");
        }
        Ok(())
    }

    fn mark(&self, event: &'static str) {
        if let Some(timing) = &self.timing {
            timing.mark(event);
        }
    }

    /// Renames the staged file over its destination, replacing any file
    /// there. On failure the staged file is removed and the destination is
    /// untouched.
    pub fn commit(mut self) -> io::Result<Committed> {
        rename(&self.temporary, &self.path)?;
        self.committed = true;
        self.mark("renamed");
        let parent = self
            .path
            .parent()
            .filter(|parent| !parent.as_os_str().is_empty())
            .unwrap_or(Path::new("."))
            .to_owned();
        Ok(Committed {
            parent,
            durable: self.durable,
            _timing: self.timing.take(),
        })
    }
}

impl Drop for StagedFile {
    fn drop(&mut self) {
        if !self.committed {
            let _ = fs::remove_file(&self.temporary);
        }
    }
}

impl Committed {
    /// Syncs the destination directory of a durable file where supported.
    pub fn sync(self) -> io::Result<()> {
        if self.durable {
            sync_directory(&self.parent).unwrap_or(Ok(()))?;
        }
        Ok(())
    }
}
