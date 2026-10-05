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
        tokio::task::spawn_blocking(move || start(&root, signals, None))
            .await
            .map_err(io::Error::other)?
    }

    /// SQLite bytes can change before a committed revision becomes visible.
    /// A source owner can compare that revision on close without treating its
    /// own read-handle closes as new work. The probe runs on the observer thread.
    pub async fn observe_with_close_probe(
        root: PathBuf,
        signals: Vec<PathBuf>,
        probe: impl FnMut() -> io::Result<bool> + Send + 'static,
    ) -> io::Result<Self> {
        tokio::task::spawn_blocking(move || start(&root, signals, Some(Box::new(probe))))
            .await
            .map_err(io::Error::other)?
    }
}
type CloseProbe = Box<dyn FnMut() -> io::Result<bool> + Send>;
fn start(
    root: &Path,
    signals: Vec<PathBuf>,
    close_probe: Option<CloseProbe>,
) -> io::Result<FileChangeWatch> {
    butler_platform::secure_fs::create_private_dir_all(root).map_err(failure)?;
    let root = butler_platform::secure_fs::canonicalize(root).map_err(failure)?;
    let signals = canonical_signals(signals)?;
    let wake = Arc::new(Notify::new());
    let failure_slot = Arc::new(Mutex::new(None));
    let signal_changed = Arc::new(AtomicBool::new(false));
    let mut observer = Observer {
        root: root.clone(),
        signals: signals.clone(),
        wake: wake.clone(),
        failure: failure_slot.clone(),
        signal_changed: signal_changed.clone(),
        closed: signals
            .iter()
            .map(|path| (path.clone(), version(path)))
            .collect(),
        close_probe,
    };
    let mut watcher =
        notify::recommended_watcher(move |event| observer.event(event)).map_err(failure)?;
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
struct Observer {
    root: PathBuf,
    signals: Vec<PathBuf>,
    wake: Arc<Notify>,
    failure: Arc<Mutex<Option<notify::Error>>>,
    signal_changed: Arc<AtomicBool>,
    closed: std::collections::HashMap<PathBuf, Option<FileVersion>>,
    close_probe: Option<CloseProbe>,
}
impl Observer {
    fn event(&mut self, event: notify::Result<notify::Event>) {
        match event {
            Ok(event) => {
                let durable = match self.durable(&event) {
                    Ok(durable) => durable,
                    Err(error) => {
                        *self.failure.lock() = Some(notify::Error::io(error));
                        self.wake.notify_one();
                        return;
                    }
                };
                let signal = event.need_rescan()
                    || event.paths.iter().any(|path| self.signals.contains(path));
                if std::env::var("BUTLER_E2E_MEMORY_SYNC_TRACE").as_deref() == Ok("1") {
                    butler_core::diagnostic!(
                        "[file-watch-trace] kind={:?} durable={durable} signal={signal}",
                        event.kind
                    );
                }
                if durable
                    && (signal || event.paths.iter().any(|path| path.starts_with(&self.root)))
                {
                    if signal {
                        self.signal_changed.store(true, Ordering::Release);
                    }
                    self.wake.notify_one();
                }
            }
            Err(error) => {
                *self.failure.lock() = Some(error);
                self.wake.notify_one();
            }
        }
    }

    fn durable(&mut self, event: &notify::Event) -> io::Result<bool> {
        if matches!(
            event.kind,
            notify::EventKind::Access(notify::event::AccessKind::Close(
                notify::event::AccessMode::Write
            ))
        ) && event.paths.iter().any(|path| self.signals.contains(path))
            && let Some(probe) = &mut self.close_probe
        {
            return probe();
        }
        Ok(durable_change(event, &self.signals, &mut self.closed))
    }
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

/// Compare close versions separately from data notifications: an unrelated
/// reader close cannot consume a later writer's final content version.
#[derive(PartialEq, Eq)]
struct FileVersion {
    id: Option<butler_platform::secure_fs::FileId>,
    modified: Option<butler_platform::secure_fs::FileTime>,
    created: Option<butler_platform::secure_fs::FileTime>,
    length: u64,
}
fn version(path: &Path) -> Option<FileVersion> {
    std::fs::metadata(path).ok().map(|metadata| {
        let identity = butler_platform::secure_fs::identity(&metadata);
        FileVersion {
            id: identity.id,
            modified: identity.modified,
            created: identity.id.is_none().then_some(identity.changed).flatten(),
            length: metadata.len(),
        }
    })
}
fn durable_change(
    event: &notify::Event,
    signals: &[PathBuf],
    closed: &mut std::collections::HashMap<PathBuf, Option<FileVersion>>,
) -> bool {
    match event.kind {
        notify::EventKind::Access(notify::event::AccessKind::Close(
            notify::event::AccessMode::Write,
        )) => {
            let mut changed = false;
            for path in event.paths.iter().filter(|path| signals.contains(path)) {
                let current = version(path);
                changed |= closed.get(path) != Some(&current);
                closed.insert(path.clone(), current);
            }
            changed
        }
        notify::EventKind::Access(_) => false,
        _ => true,
    }
}
