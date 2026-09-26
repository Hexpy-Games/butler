use std::{
    fs::{self, File},
    path::{Component, Path, PathBuf},
};

use crate::cognition::CognitionResult;

use super::error;

pub(super) fn open_owned_manifest(path: &Path, item_root: &Path) -> CognitionResult<Option<File>> {
    let canonical = match fs::canonicalize(path) {
        Ok(path) => path,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(_) => return Err(error("memory_box_manifest_read_failed")),
    };
    if !canonical.starts_with(item_root) || canonical == item_root {
        return Err(error("memory_box_manifest_path_unsafe"));
    }
    File::open(canonical)
        .map(Some)
        .map_err(|_| error("memory_box_manifest_read_failed"))
}

pub(super) fn canonical_items_root(root: &Path) -> CognitionResult<Option<PathBuf>> {
    let items = root.join("items");
    let canonical_root = match fs::canonicalize(root) {
        Ok(path) => path,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(_) => return Err(error("memory_box_items_read_failed")),
    };
    let canonical_items = match fs::canonicalize(&items) {
        Ok(path) => path,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(_) => return Err(error("memory_box_items_read_failed")),
    };
    if !canonical_items.starts_with(&canonical_root) || canonical_items == canonical_root {
        return Err(error("memory_box_items_path_unsafe"));
    }
    Ok(Some(canonical_items))
}

pub(super) fn canonical_item_root(items_root: &Path, item_dir: &Path) -> CognitionResult<PathBuf> {
    let canonical = fs::canonicalize(item_dir).map_err(|error| {
        if error.kind() == std::io::ErrorKind::NotFound {
            super::error("memory_box_manifest_missing")
        } else {
            super::error("memory_box_manifest_read_failed")
        }
    })?;
    if !canonical.starts_with(items_root) || canonical == items_root {
        return Err(error("memory_box_item_path_unsafe"));
    }
    Ok(canonical)
}

pub(super) fn validate_relative_file(item_dir: &Path, relative: &str) -> CognitionResult<PathBuf> {
    if relative.is_empty()
        || relative.contains('\\')
        || relative.contains(':')
        || Path::new(relative).is_absolute()
        || Path::new(relative)
            .components()
            .any(|component| !matches!(component, Component::Normal(_)))
    {
        return Err(error("memory_box_retention_path_unsafe"));
    }
    let item_root = fs::canonicalize(item_dir).map_err(|_| error("memory_box_item_path_unsafe"))?;
    let target = item_root.join(relative);
    crate::cognition::mutable_paths::ensure_data_authority(&item_root, &[&target])
        .map_err(|_| error("memory_box_retention_path_unsafe"))?;
    let mut ancestor = target.as_path();
    loop {
        match fs::symlink_metadata(ancestor) {
            Ok(_) => {
                let canonical = fs::canonicalize(ancestor)
                    .map_err(|_| error("memory_box_retention_path_unsafe"))?;
                if !canonical.starts_with(&item_root)
                    || (ancestor == target && canonical == item_root)
                {
                    return Err(error("memory_box_retention_path_unsafe"));
                }
                return Ok(target);
            }
            Err(io_error) if io_error.kind() == std::io::ErrorKind::NotFound => {
                ancestor = ancestor
                    .parent()
                    .ok_or_else(|| error("memory_box_retention_path_unsafe"))?;
            }
            Err(_) => return Err(error("memory_box_retention_path_unsafe")),
        }
    }
}

pub(super) fn validate_manifest_target(path: &Path, item_dir: &Path) -> CognitionResult<PathBuf> {
    let item_root = fs::canonicalize(item_dir).map_err(|_| error("memory_box_item_path_unsafe"))?;
    crate::cognition::mutable_paths::ensure_data_authority(&item_root, &[path])
        .map_err(|_| error("memory_box_manifest_path_unsafe"))?;
    let parent = path
        .parent()
        .ok_or_else(|| error("memory_box_manifest_path_unsafe"))?;
    let canonical_parent =
        fs::canonicalize(parent).map_err(|_| error("memory_box_manifest_path_unsafe"))?;
    if canonical_parent != item_root {
        return Err(error("memory_box_manifest_path_unsafe"));
    }
    match fs::symlink_metadata(path) {
        Ok(_) => {
            let target =
                fs::canonicalize(path).map_err(|_| error("memory_box_manifest_path_unsafe"))?;
            if !target.starts_with(&item_root) || target == item_root {
                return Err(error("memory_box_manifest_path_unsafe"));
            }
        }
        Err(io_error) if io_error.kind() == std::io::ErrorKind::NotFound => {}
        Err(_) => return Err(error("memory_box_manifest_path_unsafe")),
    }
    let name = path
        .file_name()
        .ok_or_else(|| error("memory_box_manifest_path_unsafe"))?;
    Ok(canonical_parent.join(name))
}

pub(super) fn safe_item_id(id: &str) -> bool {
    id.starts_with("box_")
        && !id
            .chars()
            .any(|character| matches!(character, '/' | '\\' | ':'))
        && Path::new(id)
            .components()
            .all(|component| matches!(component, Component::Normal(_)))
}
