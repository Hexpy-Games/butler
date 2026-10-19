//! Private copies for consumers that require a path rather than an fd.
use std::{
    fs::{File, OpenOptions},
    io::{self, Read},
    path::{Path, PathBuf},
};

/// Copy exactly from the validated handle into an owner-private, non-command
/// writable directory. The staged path has a unique parent and preserves the
/// display filename. Oversize and partial copies are removed on failure.
pub fn stage_file(data: &Path, name: &Path, file: File, limit: u64) -> io::Result<PathBuf> {
    let base = data.join("tmp/reader-staging");
    super::create_private_dir_all(&base)?;
    let directory = super::unique_temporary(&base.join("copy"));
    super::create_private_dir(&directory)?;
    let destination = directory.join(
        name.file_name()
            .ok_or_else(|| io::Error::other("missing_filename"))?,
    );
    let result = (|| {
        let mut options = OpenOptions::new();
        options.write(true).create_new(true);
        super::owner_only(&mut options);
        let mut target = options.open(&destination)?;
        let length = io::copy(&mut file.take(limit + 1), &mut target)?;
        if length > limit {
            return Err(io::Error::other("file_too_large"));
        }
        Ok(destination.clone())
    })();
    if result.is_err() {
        let _ = std::fs::remove_dir_all(&directory);
    }
    result
}
