//! A command owns this subscription; it observes events without reading file contents.
use notify::{Event, EventKindMask, RecommendedWatcher, RecursiveMode, Watcher};
use std::collections::BTreeSet;
use std::path::{Path, PathBuf};
use std::sync::mpsc::{Receiver, channel};
use std::time::{Duration, Instant};

/// A native event subscription owned by one running command.
pub struct CommandChanges {
    watcher: RecommendedWatcher,
    events: Receiver<notify::Result<Event>>,
    root: PathBuf,
}

/// File changes observed while the command and its output were collected.
pub struct Changes {
    /// Paths relative to the watched workspace; directories are omitted.
    pub paths: Vec<PathBuf>,
    /// False on native gaps, errors, or a root that did not become quiet.
    pub complete: bool,
}

impl CommandChanges {
    /// Subscribe to writes, metadata changes, creates, removes and renames below a root.
    pub fn watch(root: &Path) -> std::io::Result<Self> {
        let root = crate::secure_fs::canonicalize(root)?;
        let (sender, events) = channel();
        let mut watcher = RecommendedWatcher::new(
            move |event| {
                let _ = sender.send(event);
            },
            notify::Config::default().with_event_kinds(
                EventKindMask::CREATE | EventKindMask::ALL_MODIFY | EventKindMask::REMOVE,
            ),
        )
        .map_err(std::io::Error::other)?;
        watcher
            .watch(&root, RecursiveMode::Recursive)
            .map_err(std::io::Error::other)?;
        Ok(Self {
            watcher,
            events,
            root,
        })
    }

    /// Drain a short quiet interval, then close the producer and retain every queued event.
    /// A continuously changing root or native overflow is explicitly incomplete.
    pub fn finish(self) -> Changes {
        let Self {
            watcher,
            events,
            root,
        } = self;
        let mut paths = BTreeSet::new();
        let mut complete = true;
        let deadline = Instant::now() + Duration::from_millis(250);
        loop {
            let remaining = deadline.saturating_duration_since(Instant::now());
            if remaining.is_zero() {
                complete = false;
                break;
            }
            match events.recv_timeout(remaining.min(Duration::from_millis(50))) {
                Ok(event) => collect(event, &root, &mut paths, &mut complete),
                Err(std::sync::mpsc::RecvTimeoutError::Timeout) => break,
                Err(std::sync::mpsc::RecvTimeoutError::Disconnected) => {
                    complete = false;
                    break;
                }
            }
        }
        drop(watcher);
        for event in events.try_iter() {
            collect(event, &root, &mut paths, &mut complete);
        }
        Changes {
            paths: paths.into_iter().collect(),
            complete,
        }
    }
}

fn collect(
    event: notify::Result<Event>,
    root: &Path,
    paths: &mut BTreeSet<PathBuf>,
    complete: &mut bool,
) {
    let Ok(event) = event else {
        *complete = false;
        return;
    };
    if event.need_rescan() {
        *complete = false;
    }
    for path in event.paths {
        if std::fs::symlink_metadata(&path).is_ok_and(|m| m.is_dir()) {
            continue;
        }
        if let Ok(relative) = path.strip_prefix(root) {
            paths.insert(relative.to_path_buf());
        }
    }
}
