//! Observes whether the live BTCC file is ever missing while it is replaced.
//!
//! A change notification cannot answer that on every platform: Windows reports
//! the destination of an atomic replace-by-rename (`MoveFileExW` with
//! `MOVEFILE_REPLACE_EXISTING`) as a `Remove` event even though the name never
//! stops resolving. Looking the file up directly is what the guarantee is about.
use std::{
    path::{Path, PathBuf},
    sync::{
        Arc,
        atomic::{AtomicBool, Ordering},
    },
    thread::JoinHandle,
};

/// Whether a change notification for the live file means it was removed.
/// Windows signals every replace of an existing destination as a removal.
pub(super) const REMOVE_EVENT_MEANS_ABSENT: bool =
    !butler_platform::host_file_behavior::REPLACE_REPORTED_AS_REMOVE;

pub(super) struct Presence {
    absent: Arc<AtomicBool>,
    stop: Arc<AtomicBool>,
    thread: Option<JoinHandle<()>>,
}

impl Presence {
    /// Looks the file up in a tight loop until dropped.
    pub(super) fn watch(path: &Path) -> Self {
        let absent = Arc::new(AtomicBool::new(false));
        let stop = Arc::new(AtomicBool::new(false));
        let target: PathBuf = path.to_owned();
        let (seen, halt) = (absent.clone(), stop.clone());
        let thread = std::thread::spawn(move || {
            while !halt.load(Ordering::Relaxed) {
                // NotFound, or PermissionDenied: Windows answers that for an entry
                // whose deletion is pending.
                if matches!(std::fs::metadata(&target), Err(e) if matches!(
                    e.kind(),
                    std::io::ErrorKind::NotFound | std::io::ErrorKind::PermissionDenied
                )) {
                    seen.store(true, Ordering::SeqCst);
                }
                std::thread::yield_now();
            }
        });
        Self {
            absent,
            stop,
            thread: Some(thread),
        }
    }

    /// Shared flag set by this watcher, for a change-notification callback to join.
    pub(super) fn flag(&self) -> Arc<AtomicBool> {
        self.absent.clone()
    }

    pub(super) fn was_absent(&self) -> bool {
        self.absent.load(Ordering::SeqCst)
    }
}

impl Drop for Presence {
    fn drop(&mut self) {
        self.stop.store(true, Ordering::Relaxed);
        if let Some(thread) = self.thread.take() {
            let _ = thread.join();
        }
    }
}
