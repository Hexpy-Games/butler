//! Canonical secret inventory for the post-reap sweep; no content opens.
use std::{
    collections::{HashMap, HashSet},
    io,
    path::{Path, PathBuf},
};

pub(super) struct SecretTargets(HashSet<PathBuf>);

impl SecretTargets {
    pub(super) fn new(
        inventory: &[PathBuf],
        data: &Path,
        environment: &HashMap<String, String>,
    ) -> io::Result<Self> {
        let mut environment = environment.clone();
        environment.insert("BUTLER_DATA".into(), data.to_string_lossy().into_owned());
        let paths = crate::command_sandbox::credentials::roots(&environment);
        let mut roots = HashSet::new();
        for path in paths.iter().chain(inventory) {
            roots.insert(canonical_or_missing(path)?);
        }
        Ok(Self(roots))
    }

    pub(super) fn protects(&self, link: &Path) -> bool {
        // Dangling, cyclic or unresolvable aliases cannot be proven safe:
        // a later unsandboxed reader might see a newly created target.
        let Ok(target) = link.canonicalize() else {
            return true;
        };
        target.ancestors().any(|path| self.0.contains(path))
            || target.components().any(|part| {
                crate::command_sandbox::secret_name(&part.as_os_str().to_string_lossy())
            })
    }
}

fn canonical_or_missing(path: &Path) -> io::Result<PathBuf> {
    match path.canonicalize() {
        Ok(real) => Ok(real),
        Err(error) if error.kind() == io::ErrorKind::NotFound => {
            let parent = path
                .parent()
                .ok_or_else(|| io::Error::other("secret root has no parent"))?;
            let name = path
                .file_name()
                .ok_or_else(|| io::Error::other("secret root has no name"))?;
            Ok(canonical_or_missing(parent)?.join(name))
        }
        Err(error) => Err(error),
    }
}
