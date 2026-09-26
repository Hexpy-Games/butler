//! DATA resolution, alias validation, and private environment reads.

use std::{
    collections::HashMap,
    fs,
    path::{Component, Path, PathBuf},
};

use super::super::{ResolvedInstallation, installation::realpath_or_nearest};
use super::{CliError, Options};

pub(super) fn resolve_data_root(
    options: &Options,
    installation: &ResolvedInstallation,
) -> Result<PathBuf, String> {
    let home = std::env::var_os("HOME")
        .filter(|value| !value.is_empty())
        .map(PathBuf::from);
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
    let resolved = realpath_or_nearest(&absolute_normalized(&requested)?)
        .map_err(|_| "butler_data_unavailable".to_owned())?;
    installation.validate_data_root(&absolute_normalized(&resolved)?)
}

fn expand_tilde(path: PathBuf, home: Option<&Path>) -> Result<PathBuf, String> {
    let Some(value) = path.to_str() else {
        return Ok(path);
    };
    let Some(suffix) = value.strip_prefix("~") else {
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

fn absolute_normalized(path: &Path) -> Result<PathBuf, String> {
    let absolute = if path.is_absolute() {
        path.to_path_buf()
    } else {
        std::env::current_dir()
            .map_err(|_| "working directory unavailable".to_owned())?
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

pub(super) fn safe_data_file(
    installation: &ResolvedInstallation,
    data_root: &Path,
    requested: &Path,
) -> Result<PathBuf, CliError> {
    let root = absolute_normalized(data_root)
        .map_err(|message| CliError::failed("unsafe_path", message))?;
    let path = absolute_normalized(requested)
        .map_err(|message| CliError::failed("unsafe_path", message))?;
    if path == root || !path.starts_with(&root) {
        return Err(CliError::failed(
            "unsafe_path",
            "path must remain inside DATA",
        ));
    }
    let parent = path
        .parent()
        .ok_or_else(|| CliError::failed("unsafe_path", "path parent is unavailable"))?;
    let parent_real = realpath_or_nearest(parent)
        .map_err(|_| CliError::failed("unsafe_path", "path parent is unavailable"))?;
    let target_real = realpath_or_nearest(&path)
        .map_err(|_| CliError::failed("unsafe_path", "path target is unavailable"))?;
    let parent_real = absolute_normalized(&parent_real)
        .map_err(|message| CliError::failed("unsafe_path", message))?;
    let target_real = absolute_normalized(&target_real)
        .map_err(|message| CliError::failed("unsafe_path", message))?;
    if !parent_real.starts_with(&root) || !target_real.starts_with(&root) {
        return Err(CliError::failed("unsafe_path", "path aliases outside DATA"));
    }
    if let Ok(metadata) = fs::symlink_metadata(&path)
        && metadata.file_type().is_symlink()
    {
        let link = fs::read_link(&path)
            .map_err(|_| CliError::failed("unsafe_path", "path alias is unavailable"))?;
        let target = if link.is_absolute() {
            link
        } else {
            parent.join(link)
        };
        let target = realpath_or_nearest(
            &absolute_normalized(&target)
                .map_err(|message| CliError::failed("unsafe_path", message))?,
        )
        .map_err(|_| CliError::failed("unsafe_path", "path alias is unavailable"))?;
        let target = absolute_normalized(&target)
            .map_err(|message| CliError::failed("unsafe_path", message))?;
        if !target.starts_with(&root) {
            return Err(CliError::failed("unsafe_path", "path aliases outside DATA"));
        }
    }
    installation
        .validate_data_root(&target_real)
        .map_err(|_| CliError::failed("unsafe_path", "path overlaps the installation"))?;
    Ok(path)
}

pub(super) fn validate_data_mutation_paths(
    installation: &ResolvedInstallation,
    data_root: &Path,
    requested: &[&str],
) -> Result<(), CliError> {
    for requested in requested {
        let relative = Path::new(requested);
        if relative.is_absolute()
            || relative
                .components()
                .any(|component| !matches!(component, Component::Normal(_)))
        {
            return Err(CliError::failed(
                "unsafe_path",
                "mutation paths must remain inside DATA",
            ));
        }
        validate_data_mutation_path(
            installation,
            data_root,
            &absolute_normalized(data_root)
                .map_err(|message| CliError::failed("unsafe_path", message))?
                .join(relative),
        )?;
    }
    Ok(())
}

pub(super) fn validate_absolute_data_mutation_paths(
    installation: &ResolvedInstallation,
    data_root: &Path,
    requested: &[&Path],
) -> Result<(), CliError> {
    for path in requested {
        validate_data_mutation_path(installation, data_root, path)?;
    }
    Ok(())
}

fn validate_data_mutation_path(
    installation: &ResolvedInstallation,
    data_root: &Path,
    requested: &Path,
) -> Result<(), CliError> {
    let root = absolute_normalized(data_root)
        .map_err(|message| CliError::failed("unsafe_path", message))?;
    let path = absolute_normalized(requested)
        .map_err(|message| CliError::failed("unsafe_path", message))?;
    let relative = path
        .strip_prefix(&root)
        .map_err(|_| CliError::failed("unsafe_path", "mutation paths must remain inside DATA"))?;
    if relative.as_os_str().is_empty() {
        return Err(CliError::failed(
            "unsafe_path",
            "mutation paths must remain inside DATA",
        ));
    }
    let mut current = root;
    for component in relative.components() {
        if !matches!(component, Component::Normal(_)) {
            return Err(CliError::failed(
                "unsafe_path",
                "mutation paths must remain inside DATA",
            ));
        }
        current.push(component.as_os_str());
        let checked = safe_data_file(installation, data_root, &current)?;
        match fs::symlink_metadata(&checked) {
            Ok(metadata) if metadata.file_type().is_symlink() => {
                return Err(CliError::failed(
                    "unsafe_path",
                    "mutation paths cannot use DATA symlink aliases",
                ));
            }
            Ok(_) => {}
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
            Err(_) => {
                return Err(CliError::failed(
                    "unsafe_path",
                    "mutation path metadata is unavailable",
                ));
            }
        }
    }
    Ok(())
}

pub(super) fn read_private_environment(
    installation: &ResolvedInstallation,
    data_root: &Path,
    path: &Path,
) -> Result<HashMap<String, String>, CliError> {
    let path = safe_data_file(installation, data_root, path)?;
    let content = match fs::read_to_string(path) {
        Ok(content) => content,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(HashMap::new()),
        Err(_) => {
            return Err(CliError::failed(
                "private_environment_unavailable",
                "Private environment could not be read.",
            ));
        }
    };
    let mut values = HashMap::new();
    for line in content.lines() {
        let line = line.trim();
        if line.is_empty() || line.starts_with('#') {
            continue;
        }
        let Some((key, raw)) = line.split_once('=') else {
            continue;
        };
        let key = key.trim();
        if key.is_empty() {
            continue;
        }
        let mut value = raw.trim();
        if value.len() >= 2
            && ((value.starts_with('"') && value.ends_with('"'))
                || (value.starts_with('\'') && value.ends_with('\'')))
        {
            value = &value[1..value.len() - 1];
        }
        values.insert(key.to_owned(), value.to_owned());
    }
    Ok(values)
}

pub(super) fn auth_profile_path(
    data_root: &Path,
    environment: &HashMap<String, String>,
) -> PathBuf {
    ["BUTLER_CODEX_AUTH_PROFILE", "BUTLER_OPENAI_AUTH_PROFILE"]
        .iter()
        .find_map(|name| auth_env_path(name, environment))
        .map_or_else(
            || data_root.join("auth/openai-codex.json"),
            |profile| {
                let profile = PathBuf::from(profile);
                if profile.is_absolute() {
                    profile
                } else {
                    data_root.join(profile)
                }
            },
        )
}

fn auth_env_path(name: &str, environment: &HashMap<String, String>) -> Option<String> {
    std::env::var(name)
        .ok()
        .filter(|value| !value.is_empty())
        .or_else(|| {
            environment
                .get(name)
                .filter(|value| !value.is_empty())
                .cloned()
        })
}
