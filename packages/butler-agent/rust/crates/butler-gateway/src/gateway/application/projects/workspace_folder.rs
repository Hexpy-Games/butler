//! Workspace-relative browsing and selection share the same containment boundary.
use super::error;
use crate::gateway::GatewayApplicationError;
use butler_platform::secure_fs;
use serde::Serialize;
use std::{
    collections::BTreeSet,
    fs,
    io::ErrorKind,
    path::{Path, PathBuf},
};

const PAGE_SIZE: usize = 100;

pub(in crate::gateway::application) struct ResolvedFolder {
    pub root: PathBuf,
    pub path: PathBuf,
}

fn validate(path: &str) -> Result<(), GatewayApplicationError> {
    if !path.is_empty()
        && path.split('/').any(|part| {
            part.is_empty()
                || matches!(part, "." | "..")
                || part
                    .chars()
                    .any(|c| c.is_control() || matches!(c, '\\' | ':'))
        })
    {
        return Err(error(
            400,
            "project_folder_path_invalid",
            "Folder path is invalid.",
        ));
    }
    Ok(())
}

/// `None` is only the as-yet uncreated workspace root, never a missing child.
pub(in crate::gateway::application) fn resolve(
    root: &Path,
    relative: &str,
) -> Result<Option<ResolvedFolder>, GatewayApplicationError> {
    validate(relative)?;
    let root = match secure_fs::canonicalize(root) {
        Ok(root) => root,
        Err(source) if relative.is_empty() && source.kind() == std::io::ErrorKind::NotFound => {
            return Ok(None);
        }
        Err(source) => return Err(not_found().with_source(source)),
    };
    let mut candidate = root.clone();
    if !relative.is_empty() {
        for part in relative.split('/') {
            candidate.push(part);
        }
    }
    let path =
        secure_fs::canonicalize(candidate).map_err(|source| not_found().with_source(source))?;
    if !path.starts_with(&root) {
        return Err(error(
            403,
            "project_folder_outside_workspace",
            "Folder is outside the workspace.",
        ));
    }
    if !fs::metadata(&path)
        .map_err(|source| not_found().with_source(source))?
        .is_dir()
    {
        return Err(not_found());
    }
    Ok(Some(ResolvedFolder { root, path }))
}

pub(super) fn selected(
    root: &Path,
    relative: Option<&str>,
) -> Result<PathBuf, GatewayApplicationError> {
    let relative = relative
        .filter(|path| !path.is_empty())
        .ok_or_else(|| error(400, "project_folder_invalid", "Choose a subfolder."))?;
    let resolved = resolve(root, relative)?.ok_or_else(not_found)?;
    if resolved.path == resolved.root {
        return Err(error(400, "project_folder_invalid", "Choose a subfolder."));
    }
    super::folder::validate_existing(&resolved.path)
}

#[derive(Serialize)]
struct Folder {
    name: String,
}

#[derive(Serialize)]
struct Page {
    root_name: String,
    path: String,
    folders: Vec<Folder>,
    next_after: Option<String>,
}

pub(in crate::gateway::application) fn list(
    root: &Path,
    relative: &str,
    after: Option<&str>,
) -> Result<serde_json::Value, GatewayApplicationError> {
    let mut page = Page {
        root_name: root
            .file_name()
            .unwrap_or_default()
            .to_string_lossy()
            .into_owned(),
        path: relative.to_owned(),
        folders: Vec::new(),
        next_after: None,
    };
    if let Some(folder) = resolve(root, relative)? {
        let mut names = page_names(&folder.path, after)?;
        if names.len() > PAGE_SIZE {
            names.pop_last();
            page.next_after = names.last().map(|(_, name)| name.clone());
        }
        page.folders = names.into_iter().map(|(_, name)| Folder { name }).collect();
    }
    serde_json::to_value(page).map_err(GatewayApplicationError::internal_from)
}

// Read this directory only, retaining at most one page plus its continuation.
// No recursive workspace walk or resident filesystem cache is needed.
fn page_names(
    path: &Path,
    after: Option<&str>,
) -> Result<BTreeSet<(String, String)>, GatewayApplicationError> {
    let mut names = BTreeSet::new();
    let after = after.map(|name| (name.to_lowercase(), name.to_owned()));
    for entry in fs::read_dir(path).map_err(GatewayApplicationError::internal_from)? {
        let entry = entry.map_err(GatewayApplicationError::internal_from)?;
        let kind = match entry.file_type() {
            Ok(kind) => kind,
            Err(source) if source.kind() == ErrorKind::NotFound => continue,
            Err(source) => return Err(GatewayApplicationError::internal_from(source)),
        };
        if !kind.is_dir() || kind.is_symlink() {
            continue;
        }
        let name = entry.file_name().to_string_lossy().into_owned();
        if name.starts_with('.') {
            continue;
        }
        let metadata = match entry.metadata() {
            Ok(metadata) => metadata,
            Err(source) if source.kind() == ErrorKind::NotFound => continue,
            Err(source) => return Err(GatewayApplicationError::internal_from(source)),
        };
        if secure_fs::is_hidden(&metadata) {
            continue;
        }
        let key = (name.to_lowercase(), name);
        if after.as_ref().is_some_and(|after| &key <= after) {
            continue;
        }
        names.insert(key);
        if names.len() > PAGE_SIZE + 1 {
            names.pop_last();
        }
    }
    Ok(names)
}

fn not_found() -> GatewayApplicationError {
    error(404, "project_folder_not_found", "Folder was not found.")
}
