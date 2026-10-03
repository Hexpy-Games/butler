//! Lossless wake coalescing: bounded paths, with a sweep on overflow.
use super::{Arc, Command, Mutex, mpsc};
use std::collections::HashSet;

#[derive(Default)]
pub(super) struct Pending {
    pub paths: HashSet<String>,
    pub terminal: bool,
    pub overflow: bool,
}

impl Pending {
    pub(super) fn transcript(&mut self, file: String) -> bool {
        let wake = self.paths.is_empty() && !self.overflow;
        if self.paths.contains(&file) {
            return false;
        }
        if self.paths.len() < super::NOTIFICATION_CAPACITY {
            self.paths.insert(file);
        } else {
            self.overflow = true;
        }
        wake
    }
}

pub(super) fn transcript(
    pending: &std::sync::Arc<parking_lot::Mutex<Pending>>,
    sender: &tokio::sync::mpsc::Sender<super::Command>,
    file: String,
) {
    if pending.lock().transcript(file) {
        // The queued wake is only a hint. Paths and overflow survive channel saturation.
        let _ = sender.try_send(super::Command::Events);
    }
}

/// Core projections react to content changes; observing a transcript cannot requeue it.
pub(super) fn observe(
    observed: &Arc<Mutex<Pending>>,
    callback: &mpsc::Sender<Command>,
    event: notify::Result<notify::Event>,
    mutations_only: bool,
    roots: &[std::path::PathBuf; 3],
) {
    let Ok(event) = event else {
        return;
    };
    if mutations_only && matches!(event.kind, notify::EventKind::Access(_)) {
        return;
    }
    let [transcript_root, processed_root, failed_root] = roots;
    for path in event.paths {
        if path.parent() == Some(transcript_root.as_path()) {
            if path.extension().is_some_and(|value| value == "jsonl")
                && let Some(file) = path.file_name().and_then(|v| v.to_str())
            {
                transcript(observed, callback, file.to_owned());
            }
        } else if path.extension().is_none_or(|value| value != "tmp")
            && (&path == processed_root
                || &path == failed_root
                || path.parent() == Some(processed_root.as_path())
                || path.parent() == Some(failed_root.as_path()))
        {
            observed.lock().terminal = true;
            let _ = callback.try_send(Command::Events);
        }
    }
}
