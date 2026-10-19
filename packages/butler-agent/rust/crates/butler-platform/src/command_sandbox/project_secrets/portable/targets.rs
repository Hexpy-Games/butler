//! Canonical secret inventory for the post-reap sweep; no content opens.
use std::{
    collections::{HashMap, HashSet},
    io,
    path::{Path, PathBuf},
};

pub(super) struct SecretTargets {
    roots: HashSet<PathBuf>,
    credentials: HashSet<PathBuf>,
}

impl SecretTargets {
    pub(super) fn new(
        inventory: &[PathBuf],
        data: &Path,
        environment: &HashMap<String, String>,
        known: &HashMap<PathBuf, PathBuf>,
    ) -> Self {
        let mut environment = environment.clone();
        environment.insert("BUTLER_DATA".into(), data.to_string_lossy().into_owned());
        let paths = crate::command_sandbox::credentials::roots(&environment);
        // A bad entry protects its own name, never unrelated project links.
        let resolve = |path: &PathBuf| canonical_or_missing(path).unwrap_or_else(|_| path.clone());
        let credentials: HashSet<_> = paths.iter().map(resolve).collect();
        let mut roots = credentials.clone();
        roots.extend(
            inventory
                .iter()
                .map(|path| known.get(path).cloned().unwrap_or_else(|| resolve(path))),
        );
        Self { roots, credentials }
    }

    pub(super) fn protects(&self, link: &Path) -> bool {
        // Dangling, cyclic or unresolvable aliases cannot be proven safe:
        // a later unsandboxed reader might see a newly created target.
        let Ok(target) = link.canonicalize() else {
            return true;
        };
        target.ancestors().any(|path| self.roots.contains(path))
            || self
                .credentials
                .iter()
                .any(|root| root.starts_with(&target))
            || target.components().any(|part| {
                crate::command_sandbox::secret_name(&part.as_os_str().to_string_lossy())
            })
    }
}

fn canonical_or_missing(path: &Path) -> io::Result<PathBuf> {
    path.canonicalize().or_else(|error| {
        if error.kind() == io::ErrorKind::NotFound {
            crate::command_sandbox::linux::unresolved::target(path)
        } else {
            Err(error)
        }
    })
}
