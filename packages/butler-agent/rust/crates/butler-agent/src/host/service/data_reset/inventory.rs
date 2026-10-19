//! Reset boundaries come exclusively from the paths storage writers share.
use butler_platform::data_paths;
use std::{
    fs,
    path::{Path, PathBuf},
};

pub(super) const PARENTS: &[&str] = &["state", "cache", "app", "app/runtime", data_paths::LOGS];

/// A directory boundary is the first component below a retained parent.
/// A leaf file retains its exact type; whole stores include their SQLite sidecars.
pub(super) fn entries() -> Vec<(PathBuf, bool)> {
    let mut entries = Vec::new();
    for path in data_paths::OWNED_PATHS {
        let full = Path::new(path);
        let mut boundary = PathBuf::new();
        for part in full.components() {
            boundary.push(part);
            if !PARENTS.iter().any(|p| boundary == Path::new(p)) {
                break;
            }
        }
        let directory = boundary != full || data_paths::OWNED_DIRECTORIES.contains(path);
        if !entries.iter().any(|(p, _)| p == &boundary) {
            entries.push((boundary, directory));
        }
    }
    for source in data_paths::OWNED_LOG_STORES {
        entries.push((Path::new(data_paths::LOGS).join(source), true));
    }
    for path in data_paths::LOCKED_FILES {
        entries.push((PathBuf::from(format!("{path}.lock")), false));
    }
    entries
}
pub(super) fn directory(path: &Path) -> Option<bool> {
    entries()
        .into_iter()
        .find(|(p, _)| p == path)
        .map(|(_, dir)| dir)
        .or_else(|| super::logs::valid(path).then_some(false))
}
/// Inspect the entry itself. An allowlisted link is renamed, never traversed.
pub(super) fn matches(path: &Path, directory: bool, kind: fs::FileType) -> bool {
    if kind.is_symlink()
        || if directory {
            kind.is_dir()
        } else {
            kind.is_file()
        }
    {
        return true;
    }
    butler_core::diagnostic!(
        "[full-reset] retained wrong type: {} expected={}",
        path.display(),
        if directory { "directory" } else { "file" }
    );
    false
}
