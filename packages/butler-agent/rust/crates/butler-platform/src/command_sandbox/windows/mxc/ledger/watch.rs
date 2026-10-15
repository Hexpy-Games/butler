//! A kernel-completion barrier before admission; no sleep-based event settling.
use super::{inventory::FileKey, scan};
use notify_windows_ledger::{Change, Config, NAME_CHANGES, Watch};
use std::{io, path::PathBuf, time::Duration};
struct Root {
    path: PathBuf,
    key: FileKey,
    watch: Watch,
}
pub(super) struct Feed(Vec<Root>);
impl Feed {
    pub(super) fn start(roots: &[PathBuf]) -> io::Result<Self> {
        roots
            .iter()
            .map(|root| {
                // RDCW does not report changes to the watched directory itself.
                // Pin its identity until the watcher has opened the same root.
                let pin = scan::pin_root(root)?;
                let watch = Watch::new(
                    root,
                    Config {
                        flags: NAME_CHANGES,
                        buffer_bytes: 1024 * 1024,
                    },
                )?;
                Ok(Root {
                    path: root.clone(),
                    key: pin.key,
                    watch,
                })
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
        for root in &self.0 {
            if scan::root_identity(&root.path)? != root.key {
                return Err(io::Error::other("ledger watched root replaced"));
            }
            changes.extend(root.watch.drain(Duration::from_secs(2))?);
        }
        Ok(changes)
    }
}
pub(super) use notify_windows_ledger::Change as Event;
