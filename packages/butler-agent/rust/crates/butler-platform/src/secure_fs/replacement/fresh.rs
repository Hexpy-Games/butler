//! Durable publication of fresh private names, with a shared directory flush.
use super::super::{
    OWNER_ONLY, owner_only, rename, restrict_file, sync_directory, timing, unique_temporary,
};
use std::{
    fs::{self, File, OpenOptions},
    io,
    path::{Path, PathBuf},
};

/// Owns fresh files until their directory entries have been committed together.
/// A failed or dropped batch removes only names created by this batch.
/// Windows retains write-through rename when directory flushing is unavailable.
pub struct PrivateFileBatch {
    parent: PathBuf,
    paths: Vec<PathBuf>,
    committed: bool,
}

impl PrivateFileBatch {
    /// Begins an uncommitted batch in an existing private directory.
    pub fn new(parent: &Path) -> Self {
        Self {
            parent: parent.into(),
            paths: Vec::new(),
            committed: false,
        }
    }

    /// Creates a previously absent name, restricts it before writing, and flushes
    /// its bytes. Call `commit` before publishing any reference to this name.
    pub fn write(
        &mut self,
        path: &Path,
        write: impl FnOnce(&mut File) -> io::Result<()>,
    ) -> io::Result<()> {
        if path.parent() != Some(self.parent.as_path()) {
            return Err(io::Error::new(
                io::ErrorKind::InvalidInput,
                "file is outside batch directory",
            ));
        }
        let timing = timing::Timing::named("private_create");
        let mut options = OpenOptions::new();
        options.write(true).create_new(true);
        let _ = owner_only(&mut options);
        let mut file = options.open(path)?;
        timing.mark("created");
        let result = (|| {
            if !OWNER_ONLY {
                restrict_file(path).unwrap_or(Ok(()))?;
            }
            write(&mut file)?;
            timing.mark("written");
            file.sync_all()?;
            timing.mark("synced");
            Ok(())
        })();
        drop(file);
        if let Err(error) = result {
            let _ = fs::remove_file(path);
            return Err(error);
        }
        self.paths.push(path.into());
        Ok(())
    }

    /// One directory flush commits every successful write. When a filesystem
    /// cannot flush directories, retain the existing write-through publication
    /// fallback for each name rather than treating unsupported as success.
    pub fn commit(mut self) -> io::Result<()> {
        if self.paths.is_empty() {
            self.committed = true;
            return Ok(());
        }
        let timing = timing::Timing::named("private_directory_commit");
        match sync_directory(&self.parent) {
            Some(result) => result?,
            None => {
                for path in &self.paths {
                    let temporary = unique_temporary(path);
                    let mut options = OpenOptions::new();
                    options.write(true).create_new(true);
                    let _ = owner_only(&mut options);
                    drop(options.open(&temporary)?);
                    if let Err(error) = rename(path, &temporary) {
                        let _ = fs::remove_file(&temporary);
                        return Err(error);
                    }
                    if let Err(error) = rename(&temporary, path) {
                        let _ = fs::remove_file(&temporary);
                        return Err(error);
                    }
                }
            }
        }
        timing.mark("dir_synced");
        self.committed = true;
        Ok(())
    }
}

impl Drop for PrivateFileBatch {
    fn drop(&mut self) {
        if !self.committed {
            for path in &self.paths {
                let _ = fs::remove_file(path);
            }
        }
    }
}
