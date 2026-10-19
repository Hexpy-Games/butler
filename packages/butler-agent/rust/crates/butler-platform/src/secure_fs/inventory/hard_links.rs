//! Bounded credential inode snapshots, built only for hard-linked leaves.
use crate::secure_fs::{self, FileId, FileIdentity};
use std::{
    collections::HashSet,
    fs, io,
    path::{Path, PathBuf},
};

const MAX_ENTRIES: usize = 4096;

#[derive(Debug, Default)]
pub(super) enum Cache {
    #[default]
    Pending,
    Ready(Snapshot),
    Unavailable,
}
impl Cache {
    pub(super) fn permits(&mut self, roots: &[PathBuf], candidate: FileId) -> bool {
        if matches!(self, Self::Unavailable) {
            return false;
        }
        if let Self::Ready(snapshot) = self
            && snapshot.fresh()
        {
            return !snapshot.files.contains(&candidate);
        }
        match Snapshot::build(roots) {
            Ok(snapshot) => {
                let allowed = !snapshot.files.contains(&candidate);
                *self = Self::Ready(snapshot);
                allowed
            }
            Err(_) => {
                *self = Self::Unavailable;
                false
            }
        }
    }
}

#[derive(Debug)]
pub(super) struct Snapshot {
    files: HashSet<FileId>,
    observations: Vec<Observation>,
}
#[derive(Debug)]
struct Observation {
    path: PathBuf,
    identity: Option<FileIdentity>,
}
impl Snapshot {
    fn build(roots: &[PathBuf]) -> io::Result<Self> {
        let mut snapshot = Self {
            files: HashSet::new(),
            observations: Vec::new(),
        };
        let mut directories = HashSet::new();
        let mut pending = roots.to_vec();
        while let Some(path) = pending.pop() {
            if snapshot.observations.len() >= MAX_ENTRIES {
                return Err(bound());
            }
            let metadata = metadata(&path)?;
            let identity = metadata.as_ref().map(secure_fs::identity);
            snapshot.observations.push(Observation {
                path: path.clone(),
                identity,
            });
            let Some(metadata) = metadata else {
                continue;
            };
            let id = identity
                .and_then(|identity| identity.id)
                .ok_or_else(bound)?;
            if metadata.is_dir() {
                if !directories.insert(id) {
                    continue;
                }
                for child in fs::read_dir(&path)? {
                    if pending.len() + snapshot.observations.len() >= MAX_ENTRIES {
                        return Err(bound());
                    }
                    pending.push(child?.path());
                }
            } else {
                snapshot.files.insert(id);
            }
        }
        // Never cache a partial view observed across a credential rotation.
        if !snapshot.fresh() {
            return Err(bound());
        }
        Ok(snapshot)
    }

    fn fresh(&self) -> bool {
        self.observations.iter().all(|observation| {
            metadata(&observation.path).is_ok_and(|metadata| {
                metadata.as_ref().map(secure_fs::identity) == observation.identity
            })
        })
    }
}
fn metadata(path: &Path) -> io::Result<Option<fs::Metadata>> {
    match fs::metadata(path) {
        Ok(metadata) => Ok(Some(metadata)),
        Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(None),
        Err(error) => Err(error),
    }
}
fn bound() -> io::Error {
    io::Error::other("credential identity snapshot unavailable within bound")
}
