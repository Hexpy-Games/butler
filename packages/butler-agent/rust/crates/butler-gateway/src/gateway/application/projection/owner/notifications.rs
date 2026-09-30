//! Lossless wake coalescing: bounded paths, with a sweep on overflow.
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
