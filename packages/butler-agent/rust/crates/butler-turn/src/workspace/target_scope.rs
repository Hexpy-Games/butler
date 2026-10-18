//! Filesystem scope classification. Call only from a blocking worker.
use super::path_guard::{
    inside_relative, lexical_absolute, looks_sensitive, protected_path, realpath_or_nearest,
};
use butler_platform::secure_fs::{ambiguous_path, canonicalize, path_is_within};
use std::path::{Path, PathBuf};

#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord)]
pub enum TargetScope {
    NoTarget,
    ProjectFolder,
    Attachment,
    Outside,
    Protected,
}

pub struct ScopeRoots<'a> {
    pub attachments: &'a [PathBuf],
    pub project: Option<&'a Path>,
    pub butler_data: &'a Path,
    pub protected_ledger_roots: &'a [PathBuf],
    pub installation_root: Option<&'a Path>,
}
pub fn classify_targets(roots: &ScopeRoots<'_>, base: &Path, targets: &[&str]) -> TargetScope {
    if targets.is_empty() {
        return TargetScope::NoTarget;
    }
    let data = realpath_or_nearest(roots.butler_data);
    let project = roots
        .project
        .and_then(|root| canonicalize(root).ok())
        .filter(|project| !path_is_within(&data, project));
    targets
        .iter()
        .map(|target| classify(roots, base, target, project.as_deref(), &data))
        .reduce(|scope, next| match (scope, next) {
            // Attachment execution is uncontained only when every target
            // is an exact attachment, including in mixed project reads.
            (TargetScope::Attachment, TargetScope::ProjectFolder)
            | (TargetScope::ProjectFolder, TargetScope::Attachment) => TargetScope::Outside,
            _ => scope.max(next),
        })
        .unwrap_or(TargetScope::NoTarget)
}
/// How a file tool should spell `requested` so the access check, the
/// approval card and the operation name the place the OS reaches, resolved
/// as [`classify`] resolves it: relative to `root` when it really lies inside
/// though spelled another way (another spelling of the root, a link into
/// it), or the real absolute path when a link or alias leads somewhere other
/// than its spelling says. None when the spelling already names that place
/// (an in-folder path stays as written) or the path does not parse.
pub fn real_target(root: &Path, requested: &str) -> Option<PathBuf> {
    let lexical = butler_platform::tool_paths::resolve(root, requested).ok()?;
    let real = realpath_or_nearest(&lexical);
    let root_real = realpath_or_nearest(root);
    if path_is_within(&real, &root_real) {
        // An ambiguous spelling stays as written: classification keeps it
        // outside rather than trusting its containment.
        if ambiguous_path(&lexical)
            || path_is_within(&lexical, &butler_platform::tool_paths::lexical(root))
        {
            return None;
        }
        let relative = inside_relative(&root_real, &real)?;
        return Some(if relative.as_os_str().is_empty() {
            PathBuf::from(".")
        } else {
            relative
        });
    }
    (real != lexical).then_some(real)
}
fn classify(
    roots: &ScopeRoots<'_>,
    base: &Path,
    target: &str,
    project: Option<&Path>,
    data: &Path,
) -> TargetScope {
    let Ok(target) = butler_platform::tool_paths::parse(base, target) else {
        return TargetScope::Outside;
    };
    let Ok(absolute) = lexical_absolute(&base.join(target)) else {
        return TargetScope::Outside;
    };
    if ambiguous_path(&absolute) {
        return TargetScope::Outside;
    }
    let real = realpath_or_nearest(&absolute);
    if roots
        .attachments
        .iter()
        .filter(|path| {
            std::fs::symlink_metadata(path).is_ok_and(|metadata| {
                metadata.is_file() && !butler_platform::secure_fs::has_other_links(path, &metadata)
            })
        })
        .filter_map(|path| canonicalize(path).ok())
        .any(|path| path == real)
    {
        return TargetScope::Attachment;
    }
    let Some(project) = project else {
        return TargetScope::Outside;
    };
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
        // A hard link may alias a file outside the project (for example a
        // key linked in by a command); treat it like the outside original.
        || std::fs::symlink_metadata(&real)
            .is_ok_and(|metadata| butler_platform::secure_fs::has_other_links(&real, &metadata))
    {
        TargetScope::Protected
    } else {
        TargetScope::ProjectFolder
    }
}
