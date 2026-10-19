//! Bounded, best-effort credential inode defense in depth. The launch link
//! check and sandbox REFER restrictions remain the primary hard-link boundary.
use crate::secure_fs::{self, FileId};
use std::{
    collections::HashSet,
    fs,
    os::unix::fs::MetadataExt,
    path::PathBuf,
    sync::{
        Mutex, RwLock,
        atomic::{AtomicU64, Ordering},
    },
    time::{Duration, SystemTime, UNIX_EPOCH},
};

const MAX_ENTRIES: usize = 4096;

#[derive(Debug, Default)]
pub(super) struct Cache {
    snapshot: RwLock<Option<Snapshot>>,
    refresh: Mutex<()>,
    revision: AtomicU64,
}
impl Cache {
    pub(super) fn invalidate(&self) {
        self.revision.fetch_add(1, Ordering::Release);
    }

    pub(super) fn retry_errors(&self) {
        if self
            .snapshot
            .read()
            .is_ok_and(|slot| slot.as_ref().is_some_and(|s| s.incomplete))
        {
            self.invalidate();
        }
    }

    pub(super) fn permits(&self, roots: &[PathBuf], metadata: &fs::Metadata) -> bool {
        let Some(id) = secure_fs::identity(metadata).id else {
            return false;
        };
        if let Some(allowed) = self.lookup(id, metadata) {
            return allowed;
        }
        // Tree I/O never holds the read-side lock or the inventory/root mutex.
        let Ok(_refresh) = self.refresh.lock() else {
            return false;
        };
        if let Some(allowed) = self.lookup(id, metadata) {
            return allowed;
        }
        let snapshot = Snapshot::build(roots, self.revision.load(Ordering::Acquire));
        let allowed = !snapshot.files.contains(&id);
        if let Ok(mut slot) = self.snapshot.write() {
            *slot = Some(snapshot);
        }
        allowed
    }

    fn lookup(&self, id: FileId, metadata: &fs::Metadata) -> Option<bool> {
        let guard = self.snapshot.read().ok()?;
        let snapshot = guard.as_ref()?;
        let changed = Duration::new(
            metadata.ctime().try_into().ok()?,
            metadata.ctime_nsec().try_into().ok()?,
        );
        // Changed inodes are checked immediately. Unchanged nlink>1 files
        // take the O(1) path; credential root changes invalidate the snapshot.
        if snapshot.revision != self.revision.load(Ordering::Acquire) || changed >= snapshot.started
        {
            return None;
        }
        Some(!snapshot.files.contains(&id))
    }
}

#[derive(Debug)]
struct Snapshot {
    files: HashSet<FileId>,
    started: Duration,
    revision: u64,
    incomplete: bool,
}
impl Snapshot {
    fn build(roots: &[PathBuf], revision: u64) -> Self {
        let mut snapshot = Self {
            files: HashSet::new(),
            revision,
            incomplete: false,
            started: SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap_or_default(),
        };
        let mut directories = HashSet::new();
        let mut pending = roots.to_vec();
        let mut visited = 0;
        while let Some(path) = pending.pop() {
            if visited >= MAX_ENTRIES {
                break;
            }
            visited += 1;
            // An unsearchable directory cannot supply a user-created hard
            // link. A searchable but unlistable directory may be incomplete,
            // just like overflow: this scan is defense in depth, while the
            // launch link check, REFER policy, and fd walk enforce admission.
            // All failures are retried on refresh, never cached permanently.
            let metadata = match fs::metadata(&path) {
                Ok(metadata) => metadata,
                Err(error) => {
                    snapshot.incomplete |= error.kind() != std::io::ErrorKind::NotFound;
                    continue;
                }
            };
            let Some(id) = secure_fs::identity(&metadata).id else {
                continue;
            };
            if !metadata.is_dir() {
                snapshot.files.insert(id);
                continue;
            }
            if !directories.insert(id) {
                continue;
            }
            let Ok(children) = fs::read_dir(path) else {
                snapshot.incomplete = true;
                continue;
            };
            for child in children {
                let Ok(child) = child else {
                    snapshot.incomplete = true;
                    continue;
                };
                if pending.len() + visited >= MAX_ENTRIES {
                    break;
                }
                pending.push(child.path());
            }
        }
        // Overflow retains the bounded evidence instead of denying unrelated
        // package-store links. Refresh retries errors and newly created stores.
        snapshot
    }
}
