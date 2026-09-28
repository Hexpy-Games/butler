//! Source project-folder preparation and identity-safe scratch rollback.

use std::{
    fs,
    path::{Path, PathBuf},
};

use butler_platform::secure_fs::{self, FileId};
use butler_platform::user_dirs;

use super::error;
use crate::gateway::GatewayApplicationError;
use butler_core::public_text::trim_js_whitespace;

const MAX_ATTEMPTS: usize = 10_000;

#[derive(Clone)]
pub(in crate::gateway::application) struct ScratchFolder {
    pub path: PathBuf,
    /// The created folder; `None` on hosts without file ids.
    identity: Option<FileId>,
}

pub(super) fn validate_name(value: Option<&str>) -> Result<String, GatewayApplicationError> {
    let value =
        value.ok_or_else(|| error(400, "project_name_required", "Project name is required."))?;
    if value.is_empty() {
        return Err(error(
            400,
            "project_name_required",
            "Project name is required.",
        ));
    }
    if trim_js_whitespace(value) != value {
        return Err(error(
            400,
            "project_name_invalid",
            "Project name must be trimmed.",
        ));
    }
    if value.chars().count() > 80 {
        return Err(error(
            400,
            "project_name_invalid",
            "Project name must be at most 80 characters.",
        ));
    }
    if matches!(value, "." | "..")
        || value.ends_with(['.', ' '])
        || value.chars().any(|character| {
            (character as u32) <= 0x1f
                || character == '\u{7f}'
                || matches!(
                    character,
                    '/' | '\\' | '<' | '>' | ':' | '"' | '|' | '?' | '*'
                )
        })
    {
        return Err(error(
            400,
            "project_name_invalid",
            "Project name is not a safe folder name.",
        ));
    }
    let stem = value.split('.').next().unwrap_or("").to_lowercase();
    if matches!(stem.as_str(), "con" | "prn" | "aux" | "nul")
        || stem
            .strip_prefix("com")
            .or_else(|| stem.strip_prefix("lpt"))
            .is_some_and(|number| number.len() == 1 && matches!(number.as_bytes()[0], b'1'..=b'9'))
    {
        return Err(error(
            400,
            "project_name_invalid",
            "Project name is reserved by Windows.",
        ));
    }
    Ok(value.to_owned())
}

pub(super) fn create_scratch(
    root: &Path,
    name: &str,
) -> Result<ScratchFolder, GatewayApplicationError> {
    fs::create_dir_all(root).map_err(|source| {
        error(
            400,
            "project_workspace_unavailable",
            "Project workspace is not available.",
        )
        .with_source(source)
    })?;
    let root = fs::canonicalize(root).map_err(|source| {
        error(
            400,
            "project_workspace_unavailable",
            "Project workspace is not available.",
        )
        .with_source(source)
    })?;
    for index in 1..=MAX_ATTEMPTS {
        let label = if index == 1 {
            name.to_owned()
        } else {
            format!("{name} {index}")
        };
        let path = root.join(label);
        if path == root || !path.starts_with(&root) {
            return Err(error(
                400,
                "project_folder_unsafe",
                "Project folder is not safe to use.",
            ));
        }
        match fs::create_dir(&path) {
            Ok(()) => {
                let real = fs::canonicalize(&path).map_err(|source| {
                    error(
                        400,
                        "project_folder_unavailable",
                        "Project folder could not be created.",
                    )
                    .with_source(source)
                })?;
                if real == root || !real.starts_with(&root) {
                    return Err(error(
                        400,
                        "project_folder_unsafe",
                        "Project folder is not safe to use.",
                    ));
                }
                let metadata = fs::symlink_metadata(&real).map_err(|source| {
                    error(
                        400,
                        "project_folder_unavailable",
                        "Project folder could not be created.",
                    )
                    .with_source(source)
                })?;
                return Ok(ScratchFolder {
                    path: real,
                    identity: identity(&metadata),
                });
            }
            Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => {}
            Err(_) => {
                return Err(error(
                    400,
                    "project_folder_unavailable",
                    "Project folder could not be created.",
                ));
            }
        }
    }
    Err(error(
        409,
        "project_folder_name_exhausted",
        "Project folder name is unavailable.",
    ))
}

pub(super) fn validate_existing(path: &Path) -> Result<PathBuf, GatewayApplicationError> {
    let invalid = || {
        error(
            400,
            "project_folder_invalid",
            "Project folder is not available.",
        )
    };
    let metadata = fs::metadata(path).map_err(|source| invalid().with_source(source))?;
    if !metadata.is_dir() {
        return Err(error(
            400,
            "project_folder_invalid",
            "Project folder must be a directory.",
        ));
    }
    fs::read_dir(path).map_err(|source| invalid().with_source(source))?;
    let real = fs::canonicalize(path).map_err(|source| invalid().with_source(source))?;
    if sensitive(&real) {
        return Err(error(
            400,
            "project_folder_unsafe",
            "Project folder is not safe to use.",
        ));
    }
    Ok(real)
}

pub(super) fn rollback(root: &Path, folder: &ScratchFolder) {
    let _ = (|| -> std::io::Result<()> {
        let root = fs::canonicalize(root)?;
        let path = &folder.path;
        if path == &root || !path.starts_with(&root) {
            return Ok(());
        }
        let metadata = fs::symlink_metadata(path)?;
        // Without file ids nothing proves the folder is still the one this
        // request created, so it is left in place.
        let Some(created) = folder.identity else {
            return Ok(());
        };
        if !metadata.is_dir()
            || identity(&metadata) != Some(created)
            || fs::read_dir(path)?.next().is_some()
        {
            return Ok(());
        }
        fs::remove_dir(path)
    })();
}

fn sensitive(path: &Path) -> bool {
    user_dirs::is_system_folder(path) || user_dirs::home_dir().is_some_and(|home| path == home)
}

fn identity(metadata: &fs::Metadata) -> Option<FileId> {
    secure_fs::identity(metadata).id
}
