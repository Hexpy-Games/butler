//! DATA-scoped advisory lock and guarded startup task cleanup.

use std::{
    fs::{self, OpenOptions},
    path::Path,
    time::{SystemTime, UNIX_EPOCH},
};

use butler_platform::instance::InstanceLock;
use butler_platform::secure_fs;

use super::super::ResolvedInstallation;
use butler_runtime::operations;

const LOCK_RELATIVE_PATH: &str = "state/locks/mcp-startup-cleanup.lock";

pub(super) fn cleanup_old_tasks(
    data_root: &Path,
    installation: &ResolvedInstallation,
) -> Result<usize, crate::host::HostError> {
    let tasks_root = data_root.join("tasks");
    validate_under_data(data_root, &tasks_root, installation)?;
    let lock_path = data_root.join(LOCK_RELATIVE_PATH);
    let lock_parent = lock_path
        .parent()
        .ok_or_else(|| "native_mcp_cleanup_lock_path_invalid".to_owned())?;
    validate_under_data(data_root, lock_parent, installation)?;
    secure_fs::create_private_dir_all(lock_parent).map_err(|source| {
        crate::host::HostError::new("native_mcp_cleanup_lock_unavailable").with_source(source)
    })?;
    validate_under_data(data_root, lock_parent, installation)?;
    match fs::symlink_metadata(&lock_path) {
        Ok(metadata) if metadata.file_type().is_symlink() => {
            return Err("native_mcp_cleanup_lock_unavailable".into());
        }
        Ok(_) => {}
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
        Err(_) => return Err("native_mcp_cleanup_lock_unavailable".into()),
    }
    let mut options = OpenOptions::new();
    options.create(true).read(true).write(true).truncate(false);
    let _ = secure_fs::owner_only(&mut options);
    let file = options.open(&lock_path).map_err(|source| {
        crate::host::HostError::new("native_mcp_cleanup_lock_unavailable").with_source(source)
    })?;
    if fs::symlink_metadata(&lock_path)
        .map_err(|source| {
            crate::host::HostError::new("native_mcp_cleanup_lock_unavailable").with_source(source)
        })?
        .file_type()
        .is_symlink()
    {
        return Err("native_mcp_cleanup_lock_unavailable".into());
    }
    let _lock = InstanceLock::exclusive(file)
        .map_err(|error| format!("native_mcp_cleanup_lock_unavailable: {error}"))?;

    let now_ms = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs_f64()
        * 1_000.0;
    let plan =
        operations::cleanup_plan(data_root, now_ms).map_err(crate::host::HostError::from_error)?;
    let mut deleted = 0;
    for directory in plan.directories {
        validate_under_data(data_root, &directory, installation)?;
        match fs::symlink_metadata(&directory) {
            Ok(metadata) if metadata.is_dir() && !metadata.file_type().is_symlink() => {}
            Ok(_) => continue,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => continue,
            Err(error) => return Err(error.to_string().into()),
        }
        fs::remove_dir_all(&directory).map_err(crate::host::HostError::from_error)?;
        deleted += 1;
    }
    Ok(deleted)
}

fn validate_under_data(
    data_root: &Path,
    destination: &Path,
    installation: &ResolvedInstallation,
) -> Result<(), crate::host::HostError> {
    let data = installation
        .validate_data_root(data_root)
        .map_err(|source| {
            crate::host::HostError::new("native_path_configuration_invalid").with_source(source)
        })?;
    let resolved = installation
        .validate_data_root(destination)
        .map_err(|source| {
            crate::host::HostError::new("native_path_configuration_invalid").with_source(source)
        })?;
    if resolved.starts_with(&data) {
        Ok(())
    } else {
        Err("native_path_configuration_invalid".into())
    }
}
