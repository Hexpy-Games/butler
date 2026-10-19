//! Canonical secret inventory for the post-reap sweep; no content opens.
use std::{
    collections::{HashMap, HashSet},
    io,
    path::{Path, PathBuf},
};

pub(super) struct SecretTargets {
    roots: HashSet<PathBuf>,
    credentials: HashSet<PathBuf>,
    writable: Vec<PathBuf>,
    project: PathBuf,
    writable_ancestors: HashMap<PathBuf, bool>,
}

impl SecretTargets {
    pub(super) fn new(
        inventory: &[PathBuf],
        data: &Path,
        environment: &HashMap<String, String>,
        project: &Path,
        writable: &[PathBuf],
    ) -> Self {
        let mut environment = environment.clone();
        environment.insert("BUTLER_DATA".into(), data.to_string_lossy().into_owned());
        let paths = crate::command_sandbox::credentials::roots(&environment);
        // A bad entry protects its own name, never unrelated project links.
        let resolve = |path: &PathBuf| canonical_or_missing(path).unwrap_or_else(|_| path.clone());
        let credentials: HashSet<_> = paths.iter().map(resolve).collect();
        let mut roots = credentials.clone();
        roots.extend(inventory.iter().map(resolve));
        let project = resolve(&project.to_path_buf());
        let writable = writable
            .iter()
            .map(resolve)
            .filter(|path| !path.starts_with(&project))
            .collect();
        Self {
            roots,
            credentials,
            writable,
            project,
            writable_ancestors: HashMap::new(),
        }
    }

    /// Every link is judged against writable roots, including old user links:
    /// sandbox code can retarget their descendants without changing the link.
    pub(super) fn writable_target(&self, target: &Path) -> bool {
        !target.starts_with(&self.project)
            && self.writable.iter().any(|root| target.starts_with(root))
    }

    /// A final target may have escaped scratch through a newly planted link.
    /// Check the link text's ancestors too, caching shared parents only within
    /// this post-reap judgment. Never carry this cache across commands.
    pub(super) fn writable_indirection(&mut self, link: &Path, target: Option<&Path>) -> bool {
        if self.writable.is_empty() {
            return false;
        }
        if target.is_some_and(|target| self.writable_target(target)) {
            return true;
        }
        let Ok(text) = std::fs::read_link(link) else {
            return true;
        };
        let raw = link.parent().unwrap_or(Path::new("/")).join(text);
        if self.writable_target(&raw) {
            return true;
        }
        let mut visited = Vec::new();
        let mut writable = false;
        for ancestor in raw.ancestors().skip(1) {
            if let Some(known) = self.writable_ancestors.get(ancestor) {
                writable = *known;
                break;
            }
            visited.push(ancestor.to_path_buf());
            if canonical_or_missing(ancestor).is_ok_and(|path| self.writable_target(&path)) {
                writable = true;
                break;
            }
        }
        // Each cached answer includes all ancestors, so siblings stop at their
        // shared parent without repeating path resolutions or ancestor lookups.
        for path in visited {
            self.writable_ancestors.insert(path, writable);
        }
        writable
    }

    pub(super) fn protects(&self, target: &Path) -> bool {
        target.ancestors().any(|path| self.roots.contains(path))
            || self.credentials.iter().any(|root| root.starts_with(target))
            || target.components().any(|part| {
                crate::command_sandbox::secret_name(&part.as_os_str().to_string_lossy())
            })
    }
}

pub(super) fn canonical_or_missing(path: &Path) -> io::Result<PathBuf> {
    crate::command_sandbox::linux::complement::resolved_path(path).or_else(|error| {
        if error.kind() == io::ErrorKind::NotFound {
            crate::command_sandbox::linux::unresolved::target(path)
        } else {
            Err(error)
        }
    })
}
