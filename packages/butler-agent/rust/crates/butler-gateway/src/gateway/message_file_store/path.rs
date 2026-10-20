//! Source-compatible lexical scope and real-file selection.

use std::{
    collections::HashSet,
    path::{Component, Path, PathBuf},
};

use crate::gateway::ArtifactFileCandidate;

pub(super) struct AllowedPaths {
    cwd: PathBuf,
    roots: Vec<PathBuf>,
}

impl AllowedPaths {
    pub(super) fn new(roots: &[PathBuf]) -> std::io::Result<Self> {
        let cwd = std::env::current_dir()?;
        let roots: Vec<_> = roots.iter().map(|root| absolute(root, &cwd)).collect();
        Ok(Self {
            cwd: cwd.clone(),
            roots,
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

    pub(super) fn first_readable(
        &self,
        candidate: &ArtifactFileCandidate,
        seen: &HashSet<PathBuf>,
    ) -> Option<(PathBuf, std::fs::File)> {
        for original in &candidate.candidate_paths {
            let original = absolute(original, &self.cwd);
            let selected = original;
            if seen.contains(&selected) || !self.roots.iter().any(|root| selected.starts_with(root))
            {
                continue;
            }
            // Pin the root and open the leaf in one contained descriptor walk.
            for root in &self.roots {
                let container = if root == &selected {
                    root.parent()?
                } else {
                    root.as_path()
                };
                let Ok(relative) = selected.strip_prefix(container) else {
                    continue;
                };
                let inventory = butler_platform::secure_fs::SecretInventory::cached(root);
                if let Ok(file) =
                    butler_platform::secure_fs::open_contained(container, relative, &inventory)
                {
                    if root == &selected && !exact_file(&selected, &file) {
                        continue;
                    }
                    return Some((selected, file));
                }
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
        && expected_id.is_some()
        && expected_id == butler_platform::secure_fs::identity(&opened).id
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
