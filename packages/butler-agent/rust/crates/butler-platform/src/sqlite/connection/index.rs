//! macOS mapped-index writeback without closing a descriptor under SQLite locks.
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
    file: Mutex<Option<File>>,
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
}
impl Index {
    fn sync(&self) -> io::Result<()> {
        let mut file = self.file.lock().map_err(poison)?;
        if file.is_none() {
            let mut path = self.path.as_os_str().to_os_string();
            path.push("-shm");
            match crate::secure_fs::open_read_no_follow(std::path::Path::new(&path)) {
                Ok(opened) => *file = Some(opened),
                Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(()),
                Err(error) => return Err(error),
            }
        }
        file.as_ref().map_or(Ok(()), File::sync_all)
    }
}
impl Drop for Index {
    fn drop(&mut self) {
        if let Ok(mut owners) = indexes().owners.lock() {
            let file = self.file.get_mut().ok().and_then(Option::take);
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
