//! Filesystem scope classification. Call only from a blocking worker.
use super::path_guard::{
    inside_relative, lexical_absolute, looks_sensitive, protected_path, realpath_or_nearest,
};
use crate::btcc::TargetScope;
use butler_platform::secure_fs::{ambiguous_path, canonicalize, path_is_within};
use std::path::{Path, PathBuf};

pub struct ScopeRoots<'a> {
    pub project: Option<&'a Path>,
    pub butler_data: &'a Path,
    pub protected_ledger_roots: &'a [PathBuf],
    pub installation_root: Option<&'a Path>,
}
pub fn classify_targets(roots: &ScopeRoots<'_>, base: &Path, targets: &[&str]) -> TargetScope {
    if targets.is_empty() {
        return TargetScope::NoTarget;
    }
    let Some(project) = roots.project.and_then(|root| canonicalize(root).ok()) else {
        return TargetScope::Outside;
    };
    let data = realpath_or_nearest(roots.butler_data);
    if path_is_within(&data, &project) {
        return TargetScope::Outside;
    }
    targets
        .iter()
        .map(|target| classify(roots, base, target, &project, &data))
        .max()
        .unwrap_or(TargetScope::NoTarget)
}
fn classify(
    roots: &ScopeRoots<'_>,
    base: &Path,
    target: &str,
    project: &Path,
    data: &Path,
) -> TargetScope {
    let Ok(absolute) = lexical_absolute(&base.join(target)) else {
        return TargetScope::Outside;
    };
    if ambiguous_path(&absolute) {
        return TargetScope::Outside;
    }
    let real = realpath_or_nearest(&absolute);
    let installed = roots
        .installation_root
        .is_some_and(|root| path_is_within(&real, &realpath_or_nearest(root)));
    if !path_is_within(&real, project) {
        return if path_is_within(&real, data)
            || installed
            || roots
                .protected_ledger_roots
                .iter()
                .any(|root| path_is_within(&real, &realpath_or_nearest(root)))
        {
            TargetScope::Protected
        } else {
            TargetScope::Outside
        };
    }
    if inside_relative(project, &real).is_none_or(|rel| looks_sensitive(&rel.to_string_lossy()))
        || protected_path(project, &real, roots.protected_ledger_roots)
        || installed
    {
        TargetScope::Protected
    } else {
        TargetScope::ProjectFolder
    }
}
