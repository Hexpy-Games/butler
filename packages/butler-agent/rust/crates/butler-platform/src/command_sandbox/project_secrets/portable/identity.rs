//! Per-sweep filesystem coordinates, shared by all target ancestor checks.
use std::{
    collections::HashMap,
    os::unix::fs::MetadataExt,
    path::{Path, PathBuf},
};

/// Missing suffixes retain the identity of their deepest existing ancestor.
/// This also recognizes an absent credential root through a different mount.
#[derive(Clone, Debug, Eq, Hash, PartialEq)]
pub(super) enum Coordinate {
    Inode(u64, u64, PathBuf),
    Unavailable(PathBuf),
}

#[derive(Default)]
pub(super) struct Identities(HashMap<PathBuf, Coordinate>);

impl Identities {
    pub(super) fn coordinate(&mut self, path: &Path) -> Coordinate {
        if let Some(known) = self.0.get(path) {
            return known.clone();
        }
        let coordinate = match std::fs::metadata(path) {
            Ok(metadata) => Coordinate::Inode(metadata.dev(), metadata.ino(), PathBuf::new()),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                match (path.parent(), path.file_name()) {
                    (Some(parent), Some(name)) => match self.coordinate(parent) {
                        Coordinate::Inode(dev, ino, tail) => {
                            Coordinate::Inode(dev, ino, tail.join(name))
                        }
                        Coordinate::Unavailable(_) => Coordinate::Unavailable(path.to_path_buf()),
                    },
                    _ => Coordinate::Unavailable(path.to_path_buf()),
                }
            }
            Err(_) => Coordinate::Unavailable(path.to_path_buf()),
        };
        self.0.insert(path.to_path_buf(), coordinate.clone());
        coordinate
    }
}
