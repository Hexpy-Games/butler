//! Source-compatible lexical scope and real-file selection.

use std::{
    collections::HashSet,
    path::{Component, Path, PathBuf},
};

use crate::gateway::ArtifactFileCandidate;

pub(super) struct AllowedPaths {
    cwd: PathBuf,
    roots: Vec<PathBuf>,
    file_grants: HashSet<PathBuf>,
    inventory: std::sync::Arc<butler_platform::secure_fs::SecretInventory>,
}

impl AllowedPaths {
    pub(super) fn new(
        data: &Path,
        roots: &[PathBuf],
        file_grants: &[PathBuf],
    ) -> std::io::Result<Self> {
        let cwd = std::env::current_dir()?;
        let roots: Vec<_> = roots.iter().map(|root| absolute(root, &cwd)).collect();
        Ok(Self {
            inventory: butler_platform::secure_fs::SecretInventory::cached(data),
            cwd: cwd.clone(),
            roots,
            file_grants: file_grants
                .iter()
                .map(|path| absolute(path, &cwd))
                .collect(),
        })
    }

    pub(super) fn already_seen(
        &self,
        candidate: &ArtifactFileCandidate,
        seen: &HashSet<PathBuf>,
    ) -> bool {
        candidate.candidate_paths.iter().any(|path| {
            let absolute = absolute(path, &self.cwd);
            seen.contains(&absolute)
                || butler_platform::secure_fs::canonicalize(absolute)
                    .is_ok_and(|path| seen.contains(&path))
        })
    }

    /// The first candidate path that is in scope and opens; none when every one is absent or refused.
    pub(super) fn first_readable(
        &self,
        candidate: &ArtifactFileCandidate,
        seen: &HashSet<PathBuf>,
    ) -> Option<(PathBuf, std::fs::File)> {
        for original in &candidate.candidate_paths {
            let original = absolute(original, &self.cwd);
            let selected = original;
            if seen.contains(&selected) {
                continue;
            }
            let directory = self
                .roots
                .iter()
                .filter(|root| selected.starts_with(root))
                .max_by_key(|root| root.components().count());
            // File grants never override the containment of a configured project/data root.
            let (root, exact) = match directory {
                Some(root) => (root.as_path(), false),
                None if self.file_grants.contains(&selected) => (selected.parent()?, true),
                None => continue,
            };
            let Ok(relative) = selected.strip_prefix(root) else {
                continue;
            };
            match butler_platform::secure_fs::open_contained(root, relative, &self.inventory) {
                Ok(file) if exact && !exact_file(&selected, &file) => {}
                Ok(file) => return Some((selected, file)),
                Err(_) => {}
            }
        }
        None
    }
}

// A file-scoped grant authorizes that regular leaf, not links to its siblings.
fn exact_file(path: &Path, file: &std::fs::File) -> bool {
    let (Ok(expected), Ok(opened)) = (std::fs::symlink_metadata(path), file.metadata()) else {
        return false;
    };
    let expected_id = butler_platform::secure_fs::identity(&expected).id;
    expected.is_file()
        && !expected.file_type().is_symlink()
        && (!butler_platform::secure_fs::FILE_IDS
            || expected_id.is_some()
                && expected_id == butler_platform::secure_fs::identity(&opened).id)
}

fn absolute(path: &Path, cwd: &Path) -> PathBuf {
    let path = if path.is_absolute() {
        path.to_path_buf()
    } else {
        cwd.join(path)
    };
    let mut result = PathBuf::new();
    for part in path.components() {
        match part {
            Component::ParentDir => {
                result.pop();
            }
            Component::CurDir => {}
            other => result.push(other.as_os_str()),
        }
    }
    result
}
