//! Sparse identity index: ordinary single-link files occupy no ledger space.
use crate::command_sandbox::{mxc_policy::WinPath, secret_name};
use std::{
    collections::{BTreeSet, HashMap, HashSet},
    ffi::OsString,
    path::{Path, PathBuf},
};
pub(super) type FileKey = (u32, u64);
#[derive(Default)]
pub(super) struct Group {
    pub nlink: u32,
    pub public: BTreeSet<PathBuf>,
    pub private: BTreeSet<PathBuf>,
}
impl Group {
    pub(super) fn aliased(&self) -> bool {
        self.public.len() + self.private.len() != self.nlink as usize
            || (!self.public.is_empty() && !self.private.is_empty())
    }
}
#[derive(Default)]
pub(super) struct Inventory {
    pub(super) opened_files: usize,
    pub groups: HashMap<FileKey, Group>,
    pub names: HashMap<PathBuf, FileKey>,
    pub secrets: BTreeSet<PathBuf>,
}
impl Inventory {
    pub(super) fn insert(&mut self, path: PathBuf, key: FileKey, nlink: u32, private: bool) {
        self.remove_file(&path);
        if nlink <= 1 {
            return;
        }
        let group = self.groups.entry(key).or_default();
        group.nlink = nlink;
        if private {
            group.private.insert(path.clone());
        } else {
            group.public.insert(path.clone());
        }
        self.names.insert(path, key);
    }
    fn remove_file(&mut self, path: &Path) {
        if let Some(key) = self.names.remove(path)
            && let Some(group) = self.groups.get_mut(&key)
        {
            group.public.remove(path);
            group.private.remove(path);
            if group.public.is_empty() && group.private.is_empty() {
                self.groups.remove(&key);
            }
        }
    }
    pub(super) fn remove(&mut self, path: &Path) {
        self.remove_all(&HashSet::from([path.as_os_str().to_owned()]));
    }
    pub(super) fn remove_all(&mut self, paths: &HashSet<OsString>) {
        let removed = |path: &Path| path.ancestors().any(|p| paths.contains(p.as_os_str()));
        let children: Vec<_> = self.names.keys().filter(|p| removed(p)).cloned().collect();
        for child in children {
            self.remove_file(&child);
        }
        self.secrets.retain(|p| !removed(p));
    }
    pub(super) fn merge(&mut self, other: Self) {
        self.opened_files += other.opened_files;
        self.secrets.extend(other.secrets);
        for (key, group) in other.groups {
            for path in group.public {
                self.insert(path, key, group.nlink, false);
            }
            for path in group.private {
                self.insert(path, key, group.nlink, true);
            }
        }
    }
    pub(super) fn aliases(&self) -> Vec<Vec<PathBuf>> {
        let mut result: Vec<_> = self
            .groups
            .values()
            .filter(|g| g.aliased())
            .map(|g| g.public.union(&g.private).cloned().collect::<Vec<_>>())
            .collect();
        result.sort();
        result
    }
    pub(super) fn reclassify(&mut self, roots: &[PathBuf], protected: &[WinPath]) {
        for group in self.groups.values_mut() {
            let names = std::mem::take(&mut group.public)
                .into_iter()
                .chain(std::mem::take(&mut group.private));
            for path in names {
                if private(&path, roots, protected) {
                    group.private.insert(path);
                } else {
                    group.public.insert(path);
                }
            }
        }
    }
}
/// Match tree::walk's inventory (outermost secret names), but still ENTER these
/// directories in scan.rs to classify and zero-access open every contained file.
pub(super) fn secret(path: &Path, roots: &[PathBuf]) -> Option<PathBuf> {
    let root = roots.iter().find(|r| path.starts_with(r))?;
    let mut prefix = root.clone();
    for component in path.strip_prefix(root).ok()?.components() {
        prefix.push(component);
        if secret_name(&component.as_os_str().to_string_lossy()) {
            return Some(prefix);
        }
    }
    None
}
pub(super) fn private(path: &Path, roots: &[PathBuf], protected: &[WinPath]) -> bool {
    if secret(path, roots).is_some() {
        return true;
    }
    if protected.is_empty() {
        return false;
    }
    let text = path.to_string_lossy();
    WinPath::new(text.strip_prefix(r"\\?\").unwrap_or(&text))
        .map_or(true, |name| protected.iter().any(|p| name.is_within(p)))
}
