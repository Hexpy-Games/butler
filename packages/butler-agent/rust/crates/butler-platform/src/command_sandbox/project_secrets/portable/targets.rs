//! Canonical secret inventory for the post-reap sweep; no content opens.
use super::identity::{Coordinate, Identities};
use std::{
    collections::{HashMap, HashSet},
    io,
    path::{Path, PathBuf},
};

#[derive(Clone, Copy, Default)]
struct Membership {
    protected: bool,
    writable: bool,
    project: bool,
}

pub(super) struct SecretTargets {
    roots: HashSet<Coordinate>,
    credential_ancestors: HashSet<Coordinate>,
    writable: HashSet<Coordinate>,
    project: Coordinate,
    identities: Identities,
    ancestors: HashMap<PathBuf, Membership>,
    indirections: HashMap<PathBuf, bool>,
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
        let resolve =
            |path: &Path| canonical_or_missing(path).unwrap_or_else(|_| path.to_path_buf());
        let mut identities = Identities::default();
        let credentials: Vec<_> = paths.iter().map(|path| resolve(path)).collect();
        let roots = credentials
            .iter()
            .chain(inventory)
            .map(|path| identities.coordinate(&resolve(path)))
            .collect();
        let credential_ancestors = credentials
            .iter()
            .flat_map(|path| path.ancestors())
            .map(|path| identities.coordinate(path))
            .collect();
        let project = identities.coordinate(&resolve(project));
        let writable_roots = writable
            .iter()
            .map(|path| identities.coordinate(&resolve(path)))
            .collect();
        let mut result = Self {
            roots,
            credential_ancestors,
            writable: writable_roots,
            project,
            identities,
            ancestors: HashMap::new(),
            indirections: HashMap::new(),
        };
        // Project-local write grants must not classify ordinary project links
        // as scratch, even when the grant uses another mount view.
        for path in writable {
            let path = resolve(path);
            if result.membership(&path).project {
                let coordinate = result.identities.coordinate(&path);
                result.writable.remove(&coordinate);
            }
        }
        result.ancestors.clear();
        result
    }

    /// One stat per uncached path, and one ancestor walk per shared chain,
    /// entirely after reaping. Mount path spelling never establishes containment.
    fn membership(&mut self, path: &Path) -> Membership {
        if let Some(known) = self.ancestors.get(path) {
            return *known;
        }
        let mut member = path
            .parent()
            .map(|parent| self.membership(parent))
            .unwrap_or_default();
        let coordinate = self.identities.coordinate(path);
        member.protected |= self.roots.contains(&coordinate);
        member.writable |= self.writable.contains(&coordinate);
        member.project |= coordinate == self.project;
        if coordinate == self.project {
            member.writable = false;
        }
        self.ancestors.insert(path.to_path_buf(), member);
        member
    }

    fn writable_target(&mut self, target: &Path) -> bool {
        self.membership(target).writable
    }

    /// A final target may have escaped scratch through a newly planted link.
    /// Inspect the link text's ancestors as well as the final target.
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
        let mut visited = Vec::new();
        let mut writable = false;
        for ancestor in raw.ancestors().skip(1) {
            if let Some(known) = self.indirections.get(ancestor) {
                writable = *known;
                break;
            }
            visited.push(ancestor.to_path_buf());
            if canonical_or_missing(ancestor).is_ok_and(|path| self.writable_target(&path)) {
                writable = true;
                break;
            }
        }
        for path in visited {
            self.indirections.insert(path, writable);
        }
        writable
    }

    pub(super) fn protects(&mut self, target: &Path) -> bool {
        self.membership(target).protected
            || self
                .credential_ancestors
                .contains(&self.identities.coordinate(target))
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
