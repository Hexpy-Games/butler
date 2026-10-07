//! Per-walk canonical roots; ordinary entries need only lexical screening.
use crate::workspace::path_guard::{inside_relative, looks_sensitive, realpath_or_nearest};
use butler_platform::secure_fs::{Canonical as _, path_is_within};
use std::path::{Path, PathBuf};

pub(super) struct WalkGuard {
    root: PathBuf,
    protected: Vec<PathBuf>,
}
impl WalkGuard {
    pub(super) fn new(root: &Path, extra: &[PathBuf]) -> Self {
        let protected = std::iter::once(root.join(".project-ledger"))
            .chain(extra.iter().cloned())
            .map(|path| realpath_or_nearest(&path))
            .collect();
        Self {
            root: root.to_path_buf(),
            protected,
        }
    }
    pub(super) fn admits(&self, path: &Path, symlink: bool) -> bool {
        if !self.safe(path) {
            return false;
        }
        // A1: re-screen the resolved target of a symlink, never just its name.
        if symlink {
            return path.canonical().is_ok_and(|real| self.safe(&real));
        }
        true
    }
    fn safe(&self, path: &Path) -> bool {
        inside_relative(&self.root, path)
            .is_some_and(|relative| !looks_sensitive(&relative.to_string_lossy()))
            && !self.protected.iter().any(|root| path_is_within(path, root))
    }
}
