//! Private copies for consumers that require a path rather than an fd.
use sha2::{Digest, Sha256};
use std::{
    fs::File,
    io::{self, Read},
    path::{Path, PathBuf},
    sync::Mutex,
};
const MAX_TOTAL: u64 = 256 * 1024 * 1024;
static CHANGES: Mutex<()> = Mutex::new(());

/// Discard copies owned by the previous process. Call once after acquiring
/// the Agent instance lock, on a blocking worker, before admitting turns.
pub fn reset_reader_staging(data: &Path) -> io::Result<()> {
    let _lock = CHANGES
        .lock()
        .map_err(|_| io::Error::other("staging_unavailable"))?;
    let base = data.join(crate::data_paths::READER_STAGING);
    super::remove_tree(&base)
}

/// Copy from the validated handle, atomically replacing the previous copy of
/// this source. The source identity is independent of its changing contents.
pub fn stage_file(
    data: &Path,
    scope: &str,
    source: &Path,
    file: File,
    limit: u64,
) -> io::Result<PathBuf> {
    let _lock = CHANGES
        .lock()
        .map_err(|_| io::Error::other("staging_unavailable"))?;
    let base = data.join(crate::data_paths::READER_STAGING);
    super::create_private_dir_all(&base)?;
    let key = format!(
        "{:x}",
        Sha256::new()
            .chain_update(scope.len().to_le_bytes())
            .chain_update(scope.as_bytes())
            .chain_update(source.as_os_str().as_encoded_bytes())
            .finalize()
    );
    let used = total(&base)?;
    let directory = base.join(key);
    super::create_private_dir_all(&directory)?;
    let destination = directory.join(
        source
            .file_name()
            .ok_or_else(|| io::Error::other("missing_filename"))?,
    );
    // Account for the atomic replacement temporary while the old copy exists.
    let available = MAX_TOTAL.saturating_sub(used).min(limit);
    let result = super::replace_private(
        &destination,
        |target| {
            let length = io::copy(&mut file.take(available + 1), target)?;
            if length > available {
                return Err(io::Error::other("staging_limit_exceeded"));
            }
            Ok(())
        },
        std::convert::identity,
    );
    if result.is_err() {
        let _ = std::fs::remove_dir(&directory);
    }
    result?;
    lifecycle::register(data, scope, &destination);
    Ok(destination)
}
fn total(base: &Path) -> io::Result<u64> {
    let mut size = 0u64;
    for (index, directory) in std::fs::read_dir(base)?.enumerate() {
        if index >= 1024 {
            return Err(io::Error::other("staging_limit_exceeded"));
        }
        for file in std::fs::read_dir(directory?.path())? {
            size = size.saturating_add(file?.metadata()?.len());
        }
    }
    Ok(size)
}

/// Remove a consumed private stage. Never remove the caller's source file.
pub fn remove_staged(data: &Path, path: &Path) {
    let base = data.join(crate::data_paths::READER_STAGING);
    if path.strip_prefix(&base).is_ok_and(|relative| {
        relative.components().count() == 2
            && relative
                .components()
                .all(|part| matches!(part, std::path::Component::Normal(_)))
    }) {
        let _ = std::fs::remove_file(path);
        if let Some(parent) = path.parent() {
            let _ = std::fs::remove_dir(parent);
        }
    }
}

/// Cleanup on success, failure, cancellation, or an early upload refusal.
pub struct StagedFiles {
    data: PathBuf,
    paths: Vec<PathBuf>,
}
mod lifecycle;
pub use lifecycle::{StageScope, handoff_staged};
impl StagedFiles {
    /// Track only stages created by this operation.
    pub fn new(data: &Path) -> Self {
        Self {
            data: data.to_path_buf(),
            paths: Vec::new(),
        }
    }
    /// Consume the cleanup on a blocking worker before returning an upload.
    pub fn cleanup(mut self) {
        for path in self.paths.drain(..) {
            remove_staged(&self.data, &path);
        }
    }
    /// Transfer a blocking worker's cleanup ownership into its caller.
    pub fn append(&mut self, mut other: Self) -> io::Result<()> {
        if self.data != other.data {
            return Err(io::Error::other("staging_scope_mismatch"));
        }
        self.paths.append(&mut other.paths);
        Ok(())
    }
    /// Register a successfully created stage.
    pub fn push(&mut self, path: PathBuf) {
        self.paths.push(path);
    }
}
impl Drop for StagedFiles {
    fn drop(&mut self) {
        let data = self.data.clone();
        let paths = std::mem::take(&mut self.paths);
        if paths.is_empty() {
            return;
        }
        // A rejected blocking task drops its closure during runtime shutdown.
        // Keep cleanup in a guard so that path also removes the copies.
        let cleanup = Cleanup { data, paths };
        if let Ok(runtime) = tokio::runtime::Handle::try_current() {
            runtime.spawn_blocking(move || drop(cleanup));
        } else {
            drop(cleanup);
        }
    }
}

struct Cleanup {
    data: PathBuf,
    paths: Vec<PathBuf>,
}
impl Drop for Cleanup {
    fn drop(&mut self) {
        for path in &self.paths {
            remove_staged(&self.data, path);
        }
    }
}
