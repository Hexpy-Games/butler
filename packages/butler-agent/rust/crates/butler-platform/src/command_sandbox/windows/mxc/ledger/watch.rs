//! A kernel-completion barrier before admission; no sleep-based event settling.
use super::{inventory::FileKey, scan};
use notify_windows_ledger::{Change, Config, NAME_CHANGES, Watch};
use std::{io, path::PathBuf, sync::Mutex, time::Duration};
// Bound events consumed by all overlapping sweeps, not just one native drain.
const MAX_REPLAY_CHANGES: usize = 100_000;
struct Root {
    path: PathBuf,
    key: FileKey,
    watch: Watch,
}
pub(super) struct Feed {
    roots: Vec<Root>,
    journal: Mutex<Option<Vec<Change>>>,
}
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
            .map(|roots| Self {
                roots,
                journal: Mutex::new(None),
            })
    }
    pub(super) fn extend(&mut self, roots: &[PathBuf]) -> io::Result<()> {
        self.roots.extend(Self::start(roots)?.roots);
        Ok(())
    }
    pub(super) fn begin_verify(&self) -> io::Result<()> {
        *self
            .journal
            .lock()
            .map_err(|_| io::Error::other("ledger journal poisoned"))? = Some(Vec::new());
        Ok(())
    }
    pub(super) fn finish_verify(&self) -> io::Result<Vec<Change>> {
        self.journal
            .lock()
            .map_err(|_| io::Error::other("ledger journal poisoned"))?
            .take()
            .ok_or_else(|| io::Error::other("ledger verify journal missing"))
    }
    pub(super) fn drain(&self) -> io::Result<Vec<Change>> {
        let result = self.drain_roots();
        let mut journal = self
            .journal
            .lock()
            .map_err(|_| io::Error::other("ledger journal poisoned"))?;
        if let Some(journal) = journal.as_mut() {
            match &result {
                Ok(events) if journal.len() + events.len() <= MAX_REPLAY_CHANGES => {
                    journal.extend(events.iter().cloned());
                }
                _ => {
                    // A sweep may consume events while the full scan runs. Keep
                    // those events, or force a rebuild; never commit partial knowledge.
                    journal.clear();
                    journal.push(Change::Rescan);
                    return Err(io::Error::other("ledger verify journal lost"));
                }
            }
        }
        result
    }
    fn drain_roots(&self) -> io::Result<Vec<Change>> {
        let mut changes = Vec::new();
        for root in &self.roots {
            if scan::root_identity(&root.path)? != root.key {
                return Err(io::Error::other("ledger watched root replaced"));
            }
            changes.extend(root.watch.drain(Duration::from_secs(2))?);
        }
        Ok(changes)
    }
}
pub(super) use notify_windows_ledger::Change as Event;

#[cfg(feature = "test-support")]
impl Feed {
    pub(super) fn exercise(&self, kind: &str) -> io::Result<()> {
        self.roots
            .first()
            .ok_or_else(|| io::Error::other("missing watch root"))?
            .watch
            .exercise(kind)
    }
    pub(super) fn lose_journal(&self) -> io::Result<()> {
        self.journal
            .lock()
            .map_err(|_| io::Error::other("journal poisoned"))?
            .take();
        Ok(())
    }
}
