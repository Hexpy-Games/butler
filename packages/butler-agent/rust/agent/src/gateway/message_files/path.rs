//! Source-compatible lexical scope and real-file selection.

use std::{
    collections::HashSet,
    path::{Component, Path, PathBuf},
};

use crate::gateway::ArtifactFileCandidate;

pub(super) struct AllowedPaths {
    cwd: PathBuf,
    roots: Vec<PathBuf>,
    canonical: Vec<PathBuf>,
}

impl AllowedPaths {
    pub(super) fn new(roots: &[PathBuf]) -> std::io::Result<Self> {
        let cwd = std::env::current_dir()?;
        let roots: Vec<_> = roots.iter().map(|root| absolute(root, &cwd)).collect();
        let canonical = roots
            .iter()
            .map(|root| std::fs::canonicalize(root).unwrap_or_else(|_| root.clone()))
            .collect();
        Ok(Self {
            cwd: cwd.clone(),
            roots,
            canonical,
        })
    }

    pub(super) fn first_readable(
        &self,
        candidate: &ArtifactFileCandidate,
        seen: &HashSet<PathBuf>,
    ) -> Option<PathBuf> {
        for original in &candidate.candidate_paths {
            let original = absolute(original, &self.cwd);
            let selected = original;
            if seen.contains(&selected) || !self.roots.iter().any(|root| selected.starts_with(root))
            {
                continue;
            }
            let Ok(metadata) = std::fs::symlink_metadata(&selected) else {
                continue;
            };
            if !metadata.is_file() || metadata.file_type().is_symlink() {
                continue;
            }
            let Ok(real) = std::fs::canonicalize(&selected) else {
                continue;
            };
            if self.canonical.iter().any(|root| real.starts_with(root)) {
                return Some(real);
            }
        }
        None
    }
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
