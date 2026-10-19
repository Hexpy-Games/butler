//! Bounded, best-effort credential inode defense in depth. The launch link
//! check and sandbox REFER restrictions remain the primary hard-link boundary.
use crate::secure_fs::{self, FileId};
use std::{
    collections::HashSet,
    fs,
    os::unix::fs::MetadataExt,
    path::PathBuf,
    sync::{Mutex, RwLock},
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};

const MAX_ENTRIES: usize = 4096;
const TTL: Duration = Duration::from_millis(250);

#[derive(Debug, Default)]
pub(super) struct Cache {
    snapshot: RwLock<Option<Snapshot>>,
    refresh: Mutex<()>,
}
impl Cache {
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
        let snapshot = Snapshot::build(roots);
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
        // A newly linked credential must be checked immediately, even during the
        // TTL. Ordinary nlink>1 files predate the snapshot and take the O(1) path.
        if snapshot.built.elapsed() >= TTL || changed >= snapshot.started {
            return None;
        }
        Some(!snapshot.files.contains(&id))
    }
}

#[derive(Debug)]
struct Snapshot {
    files: HashSet<FileId>,
    started: Duration,
    built: Instant,
}
impl Snapshot {
    fn build(roots: &[PathBuf]) -> Self {
        let mut snapshot = Self {
            files: HashSet::new(),
            started: SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap_or_default(),
            built: Instant::now(),
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
            let Ok(metadata) = fs::metadata(&path) else {
                continue;
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
                continue;
            };
            for child in children.flatten() {
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
