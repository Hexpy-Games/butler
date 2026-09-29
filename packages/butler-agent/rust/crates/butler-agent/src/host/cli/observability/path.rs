use std::{
    fs,
    path::{Component, Path, PathBuf},
};

use super::{Options, ResolvedInstallation};
use crate::host::installation::realpath_or_nearest;

pub(super) fn resolve_data_root(
    options: &Options,
    installation: &ResolvedInstallation,
) -> Result<PathBuf, crate::host::HostError> {
    let home = butler_platform::user_dirs::non_empty_home_dir();
    let requested = options
        .data
        .clone()
        .or_else(|| {
            std::env::var_os("BUTLER_DATA")
                .filter(|value| !value.is_empty())
                .map(PathBuf::from)
        })
        .or_else(|| home.as_ref().map(|home| home.join(".butler")))
        .ok_or_else(|| "native_home_unavailable".to_owned())?;
    let requested = expand_tilde(requested, home.as_deref())?;
    let requested = absolute_normalized(&requested)?;
    let resolved = realpath_or_nearest(&requested).map_err(|source| {
        crate::host::HostError::new("butler_data_unavailable").with_source(source)
    })?;
    installation.validate_data_root(&absolute_normalized(&resolved)?)
}

pub(super) fn safe_data_file(
    installation: &ResolvedInstallation,
    data_root: &Path,
    requested: &Path,
) -> Result<PathBuf, crate::host::HostError> {
    let root = absolute_normalized(data_root)?;
    let path = absolute_normalized(requested)?;
    if path == root || !path.starts_with(&root) {
        return Err("path must remain inside DATA".into());
    }
    let parent = path
        .parent()
        .ok_or_else(|| "path parent is unavailable".to_owned())?;
    let parent_real = absolute_normalized(&realpath_or_nearest(parent).map_err(|source| {
        crate::host::HostError::new("path parent is unavailable").with_source(source)
    })?)?;
    let target_real = absolute_normalized(&realpath_or_nearest(&path).map_err(|source| {
        crate::host::HostError::new("path target is unavailable").with_source(source)
    })?)?;
    if !parent_real.starts_with(&root) || !target_real.starts_with(&root) {
        return Err("path aliases outside DATA".into());
    }
    if let Ok(metadata) = fs::symlink_metadata(&path)
        && metadata.file_type().is_symlink()
    {
        let link = fs::read_link(&path).map_err(|source| {
            crate::host::HostError::new("path alias is unavailable").with_source(source)
        })?;
        let target = if link.is_absolute() {
            link
        } else {
            parent.join(link)
        };
        let target = absolute_normalized(
            &realpath_or_nearest(&absolute_normalized(&target)?).map_err(|source| {
                crate::host::HostError::new("path alias is unavailable").with_source(source)
            })?,
        )?;
        if !target.starts_with(&root) {
            return Err("path aliases outside DATA".into());
        }
    }
    installation
        .validate_data_root(&target_real)
        .map_err(|source| {
            crate::host::HostError::new("path overlaps the installation").with_source(source)
        })?;
    Ok(path)
}

fn expand_tilde(path: PathBuf, home: Option<&Path>) -> Result<PathBuf, crate::host::HostError> {
    let Some(value) = path.to_str() else {
        return Ok(path);
    };
    let Some(suffix) = value.strip_prefix('~') else {
        return Ok(path);
    };
    if !suffix.is_empty() && !suffix.starts_with('/') {
        return Ok(path);
    }
    let home = home.ok_or_else(|| "native_home_unavailable".to_owned())?;
    Ok(if suffix.is_empty() {
        home.to_path_buf()
    } else {
        home.join(&suffix[1..])
    })
}

fn absolute_normalized(path: &Path) -> Result<PathBuf, crate::host::HostError> {
    let absolute = if path.is_absolute() {
        path.to_path_buf()
    } else {
        std::env::current_dir()
            .map_err(|source| {
                crate::host::HostError::new("working directory unavailable").with_source(source)
            })?
            .join(path)
    };
    let mut normalized = PathBuf::new();
    for component in absolute.components() {
        match component {
            Component::CurDir => {}
            Component::ParentDir => {
                if normalized.file_name().is_some() {
                    normalized.pop();
                }
            }
            other => normalized.push(other.as_os_str()),
        }
    }
    Ok(normalized)
}
