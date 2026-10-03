//! Scoped native filesystem notifications, including out-of-process writers.
use notify::{RecommendedWatcher, RecursiveMode, Watcher};
use parking_lot::Mutex;
use std::io;
use std::sync::atomic::{AtomicBool, Ordering};
use std::{
    path::{Path, PathBuf},
    sync::Arc,
};
use tokio::sync::Notify;

/// A scoped native observer; dropping it releases the watcher thread and handles.
pub struct FileChangeWatch {
    _watcher: RecommendedWatcher,
    wake: Arc<Notify>,
    failure: Arc<Mutex<Option<notify::Error>>>,
    signal_changed: Arc<AtomicBool>,
}
impl FileChangeWatch {
    /// Wait for a durable change, or fail closed if the observer failed.
    pub async fn changed(&self) -> io::Result<bool> {
        self.wake.notified().await;
        match self.failure.lock().take() {
            Some(error) => Err(failure(error)),
            None => Ok(self.signal_changed.swap(false, Ordering::AcqRel)),
        }
    }
}
impl FileChangeWatch {
    /// Subscribe before reading state; durable writes cannot fall between them.
    pub async fn observe(root: PathBuf, signals: Vec<PathBuf>) -> io::Result<Self> {
        tokio::task::spawn_blocking(move || start(&root, signals))
            .await
            .map_err(io::Error::other)?
    }
}
fn start(root: &Path, signals: Vec<PathBuf>) -> io::Result<FileChangeWatch> {
    butler_platform::secure_fs::create_private_dir_all(root).map_err(failure)?;
    let root = butler_platform::secure_fs::canonicalize(root).map_err(failure)?;
    let signals = canonical_signals(signals)?;
    let wake = Arc::new(Notify::new());
    let failure_slot = Arc::new(Mutex::new(None));
    let signal_changed = Arc::new(AtomicBool::new(false));
    let signals_callback = signal_changed.clone();
    let callback = wake.clone();
    let failed = failure_slot.clone();
    let watched = root.clone();
    let watched_signals = signals.clone();
    let mut watcher =
        notify::recommended_watcher(move |event: notify::Result<notify::Event>| match event {
            Ok(event) if !matches!(event.kind, notify::EventKind::Access(_)) => {
                if event.need_rescan()
                    || event
                        .paths
                        .iter()
                        .any(|path| path.starts_with(&watched) || watched_signals.contains(path))
                {
                    if event.need_rescan()
                        || event
                            .paths
                            .iter()
                            .any(|path| watched_signals.contains(path))
                    {
                        signals_callback.store(true, Ordering::Release);
                    }
                    callback.notify_one();
                }
            }
            Err(error) => {
                *failed.lock() = Some(error);
                callback.notify_one();
            }
            _ => {}
        })
        .map_err(failure)?;
    watcher
        .watch(&root, RecursiveMode::Recursive)
        .map_err(failure)?;
    let mut parents = std::collections::HashSet::new();
    for path in signals {
        if let Some(parent) = path.parent()
            && parents.insert(parent.to_owned())
        {
            watcher
                .watch(parent, RecursiveMode::NonRecursive)
                .map_err(failure)?;
        }
    }
    Ok(FileChangeWatch {
        _watcher: watcher,
        wake,
        failure: failure_slot,
        signal_changed,
    })
}
fn failure(error: impl std::fmt::Display) -> io::Error {
    io::Error::other(error.to_string())
}

fn canonical_signals(signals: Vec<PathBuf>) -> io::Result<Vec<PathBuf>> {
    signals
        .into_iter()
        .map(|path| {
            let parent = path
                .parent()
                .ok_or_else(|| failure("Control path has no parent"))?;
            butler_platform::secure_fs::create_private_dir_all(parent).map_err(failure)?;
            let parent = butler_platform::secure_fs::canonicalize(parent).map_err(failure)?;
            Ok(parent.join(
                path.file_name()
                    .ok_or_else(|| failure("Control path has no name"))?,
            ))
        })
        .collect::<io::Result<Vec<_>>>()
}
