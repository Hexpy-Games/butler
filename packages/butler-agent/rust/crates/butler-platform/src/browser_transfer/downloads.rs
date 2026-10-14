//! Event-driven Downloads watching. Only new CSV files since explicit consent qualify.
use super::{ImportError, io_error};
use notify::{RecommendedWatcher, RecursiveMode, Watcher};
use std::collections::HashSet;
use std::path::{Path, PathBuf};
use std::sync::mpsc::{Receiver, channel};
use std::time::{Duration, Instant};

/// An explicit three-minute native directory subscription.
pub struct DownloadWatch {
    _watcher: RecommendedWatcher,
    events: Receiver<notify::Result<notify::Event>>,
    existing: HashSet<PathBuf>,
    root: PathBuf,
    expires: Instant,
}
impl DownloadWatch {
    /// Watch the current home Downloads directory.
    pub fn start() -> Result<Self, ImportError> {
        let home = crate::user_dirs::non_empty_home_dir().ok_or(ImportError::NotFound)?;
        Self::at(&home.join("Downloads"))
    }
    /// Watch a supplied directory (also used by isolated fixtures).
    pub fn at(root: &Path) -> Result<Self, ImportError> {
        let (tx, events) = channel();
        let mut watcher = notify::recommended_watcher(move |event| {
            let _ = tx.send(event);
        })
        .map_err(|_| ImportError::PermissionDenied)?;
        watcher
            .watch(root, RecursiveMode::NonRecursive)
            .map_err(|_| ImportError::PermissionDenied)?;
        let existing = std::fs::read_dir(root)
            .map_err(|e| io_error(&e))?
            .filter_map(Result::ok)
            .map(|entry| entry.path())
            .collect();
        Ok(Self {
            _watcher: watcher,
            events,
            existing,
            root: root.to_path_buf(),
            expires: Instant::now() + Duration::from_secs(180),
        })
    }
    /// A short wait lets HTTP polls release the worker; no directory scans or file reads.
    pub fn next_csv(&self) -> Result<Option<PathBuf>, ImportError> {
        if Instant::now() >= self.expires {
            return Err(ImportError::NotFound);
        }
        while let Ok(event) = self.events.recv_timeout(Duration::from_millis(400)) {
            for path in event.map_err(|_| ImportError::Format)?.paths {
                if path.parent() != Some(self.root.as_path())
                    || self.existing.contains(&path)
                    || !path
                        .extension()
                        .is_some_and(|e| e.eq_ignore_ascii_case("csv"))
                {
                    continue;
                }
                let meta = std::fs::symlink_metadata(&path).map_err(|e| io_error(&e))?;
                if !meta.is_file() || meta.len() == 0 {
                    continue;
                }
                std::thread::sleep(Duration::from_millis(300));
                if std::fs::metadata(&path).map_err(|e| io_error(&e))?.len() == meta.len() {
                    return Ok(Some(path));
                }
            }
        }
        Ok(None)
    }
}
