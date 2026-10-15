//! A kernel-completion barrier before admission; no sleep-based event settling.
use notify_windows_ledger::{Change, Config, NAME_CHANGES, Watch};
use std::{io, path::PathBuf, time::Duration};
pub(super) struct Feed(Vec<Watch>);
impl Feed {
    pub(super) fn start(roots: &[PathBuf]) -> io::Result<Self> {
        roots
            .iter()
            .map(|root| {
                Watch::new(
                    root,
                    Config {
                        flags: NAME_CHANGES,
                        buffer_bytes: 1024 * 1024,
                    },
                )
            })
            .collect::<io::Result<Vec<_>>>()
            .map(Self)
    }
    pub(super) fn extend(&mut self, roots: &[PathBuf]) -> io::Result<()> {
        self.0.extend(Self::start(roots)?.0);
        Ok(())
    }
    pub(super) fn drain(&self) -> io::Result<Vec<Change>> {
        let mut changes = Vec::new();
        for watch in &self.0 {
            changes.extend(watch.drain(Duration::from_secs(2))?);
        }
        Ok(changes)
    }
}
pub(super) use notify_windows_ledger::Change as Event;
