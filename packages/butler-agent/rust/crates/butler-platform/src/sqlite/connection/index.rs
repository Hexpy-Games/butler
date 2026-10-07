//! macOS mapped-index writeback without closing a descriptor under SQLite locks.
use memmap2::{MmapOptions, MmapRaw};
use std::{
    collections::BTreeMap,
    fs::File,
    io,
    path::PathBuf,
    sync::{Arc, Condvar, Mutex, OnceLock, Weak},
};

static INDEXES: OnceLock<Registry> = OnceLock::new();
struct Registry {
    owners: Mutex<BTreeMap<PathBuf, Weak<Index>>>,
    closed: Condvar,
}
fn indexes() -> &'static Registry {
    INDEXES.get_or_init(|| Registry {
        owners: Mutex::default(),
        closed: Condvar::new(),
    })
}
fn poison<T>(_: std::sync::PoisonError<T>) -> io::Error {
    io::Error::other("WAL-index owner lock poisoned")
}

pub(super) struct IndexOwner(Option<Arc<Index>>);
struct Index {
    path: PathBuf,
    file: Mutex<Option<IndexFile>>,
}
struct IndexFile {
    mapped: Option<MmapRaw>,
    file: File,
}
impl IndexFile {
    fn sync(&mut self) -> io::Result<()> {
        let len = usize::try_from(self.file.metadata()?.len()).map_err(io::Error::other)?;
        if self.mapped.as_ref().map(MmapRaw::len) != Some(len) {
            self.mapped = if len == 0 {
                None
            } else {
                // Raw maps expose no Rust references to SQLite's concurrently
                // changed bytes. Remapping never opens/closes another descriptor.
                Some(MmapOptions::new().len(len).map_raw_read_only(&self.file)?)
            };
        }
        if let Some(mapped) = &self.mapped {
            // fsync alone can leave mapped dirty pages and their mtime for
            // Darwin's delayed writeback. MS_SYNC finishes them during work.
            mapped.flush()?;
        }
        self.file.sync_all()
    }
}
impl IndexOwner {
    pub(super) fn new(connection: &rusqlite::Connection) -> io::Result<Self> {
        let Some(path) = connection.path().filter(|path| !path.is_empty()) else {
            return Ok(Self(None));
        };
        let path = std::fs::canonicalize(path)?;
        let mut owners = indexes().owners.lock().map_err(poison)?;
        let owner = loop {
            match owners.get(&path) {
                Some(previous) => {
                    if let Some(owner) = previous.upgrade() {
                        break owner;
                    }
                    // The last owner must close its descriptor before a new
                    // connection may use this inode's process-scoped locks.
                    owners = indexes().closed.wait(owners).map_err(poison)?;
                }
                None => {
                    let owner = Arc::new(Index {
                        path: path.clone(),
                        file: Mutex::new(None),
                    });
                    owners.insert(path, Arc::downgrade(&owner));
                    break owner;
                }
            }
        };
        Ok(Self(Some(owner)))
    }
    pub(super) fn sync(&self) -> io::Result<()> {
        self.0.as_ref().map_or(Ok(()), |owner| owner.sync())
    }
    pub(super) fn finish(mut self) -> io::Result<()> {
        let result = self.sync();
        self.0 = None;
        result
    }
}
impl Drop for IndexOwner {
    fn drop(&mut self) {
        // Connection drops its raw SQLite field first. RAII health/admission
        // probes and retired readers must finish their read-mark writeback too.
        // Explicit close uses finish() to report errors without syncing twice.
        let _closed = self.sync();
    }
}
impl Index {
    fn sync(&self) -> io::Result<()> {
        let mut file = self.file.lock().map_err(poison)?;
        if file.is_none() {
            let mut path = self.path.as_os_str().to_os_string();
            path.push("-shm");
            match crate::secure_fs::open_read_no_follow(std::path::Path::new(&path)) {
                Ok(opened) => {
                    *file = Some(IndexFile {
                        mapped: None,
                        file: opened,
                    });
                }
                Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(()),
                Err(error) => return Err(error),
            }
        }
        file.as_mut().map_or(Ok(()), IndexFile::sync)
    }
}
impl Drop for Index {
    fn drop(&mut self) {
        if let Ok(mut owners) = indexes().owners.lock() {
            let file = match self.file.get_mut() {
                Ok(file) => file.take(),
                Err(poisoned) => poisoned.into_inner().take(),
            };
            drop(file);
            owners.remove(&self.path);
            indexes().closed.notify_all();
        }
    }
}
pub(super) fn sync(connection: &rusqlite::Connection) -> io::Result<()> {
    let Some(path) = connection.path().filter(|path| !path.is_empty()) else {
        return Ok(());
    };
    let path = std::fs::canonicalize(path)?;
    let owner = indexes()
        .owners
        .lock()
        .map_err(poison)?
        .get(&path)
        .and_then(Weak::upgrade)
        .ok_or_else(|| io::Error::other("WAL-index connection is not tracked"))?;
    owner.sync()
}
