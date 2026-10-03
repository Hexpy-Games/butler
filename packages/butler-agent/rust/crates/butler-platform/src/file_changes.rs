//! Owned native filesystem notifications; no polling or file-content reads.
use notify::{EventKind, RecommendedWatcher, RecursiveMode, Watcher};
use std::{io, path::Path, sync::Arc};

/// A native watcher whose lifetime is owned by its caller.
pub struct FileChanges {
    _watcher: RecommendedWatcher,
}

impl FileChanges {
    /// Watch directory entries and wake after mutations or watcher errors.
    pub fn directories(paths: &[&Path], wake: Arc<tokio::sync::Notify>) -> io::Result<Self> {
        let mut watcher =
            notify::recommended_watcher(move |event: notify::Result<notify::Event>| {
                // Access notifications cannot represent a newly admitted item.
                if event.is_err() || event.is_ok_and(|e| !matches!(e.kind, EventKind::Access(_))) {
                    wake.notify_one();
                }
            })
            .map_err(io::Error::other)?;
        for path in paths {
            std::fs::create_dir_all(path)?;
            watcher
                .watch(path, RecursiveMode::NonRecursive)
                .map_err(io::Error::other)?;
        }
        Ok(Self { _watcher: watcher })
    }
}
