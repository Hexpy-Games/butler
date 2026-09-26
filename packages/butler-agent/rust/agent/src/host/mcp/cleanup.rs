//! DATA-scoped advisory lock and guarded startup task cleanup.

use std::{
    fs::{self, OpenOptions},
    os::unix::fs::{DirBuilderExt, OpenOptionsExt},
    path::Path,
    time::{SystemTime, UNIX_EPOCH},
};

use nix::fcntl::{Flock, FlockArg};

use super::super::ResolvedInstallation;
use crate::operations;

const LOCK_RELATIVE_PATH: &str = "state/locks/mcp-startup-cleanup.lock";

pub(super) fn cleanup_old_tasks(
    data_root: &Path,
    installation: &ResolvedInstallation,
) -> Result<usize, String> {
    let tasks_root = data_root.join("tasks");
    validate_under_data(data_root, &tasks_root, installation)?;
    let lock_path = data_root.join(LOCK_RELATIVE_PATH);
    let lock_parent = lock_path
        .parent()
        .ok_or_else(|| "native_mcp_cleanup_lock_path_invalid".to_owned())?;
    validate_under_data(data_root, lock_parent, installation)?;
    fs::DirBuilder::new()
        .recursive(true)
        .mode(0o700)
        .create(lock_parent)
        .map_err(|_| "native_mcp_cleanup_lock_unavailable".to_owned())?;
    validate_under_data(data_root, lock_parent, installation)?;
    match fs::symlink_metadata(&lock_path) {
        Ok(metadata) if metadata.file_type().is_symlink() => {
            return Err("native_mcp_cleanup_lock_unavailable".into());
        }
        Ok(_) => {}
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
        Err(_) => return Err("native_mcp_cleanup_lock_unavailable".into()),
    }
    let file = OpenOptions::new()
        .create(true)
        .read(true)
        .write(true)
        .truncate(false)
        .mode(0o600)
        .open(&lock_path)
        .map_err(|_| "native_mcp_cleanup_lock_unavailable".to_owned())?;
    if fs::symlink_metadata(&lock_path)
        .map_err(|_| "native_mcp_cleanup_lock_unavailable")?
        .file_type()
        .is_symlink()
    {
        return Err("native_mcp_cleanup_lock_unavailable".into());
    }
    let _lock = Flock::lock(file, FlockArg::LockExclusive)
        .map_err(|(_, error)| format!("native_mcp_cleanup_lock_unavailable: {error}"))?;

    let now_ms = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs_f64()
        * 1_000.0;
    let plan = operations::cleanup_plan(data_root, now_ms)?;
    let mut deleted = 0;
    for directory in plan.directories {
        validate_under_data(data_root, &directory, installation)?;
        match fs::symlink_metadata(&directory) {
            Ok(metadata) if metadata.is_dir() && !metadata.file_type().is_symlink() => {}
            Ok(_) => continue,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => continue,
            Err(error) => return Err(error.to_string()),
        }
        fs::remove_dir_all(&directory).map_err(|error| error.to_string())?;
        deleted += 1;
    }
    Ok(deleted)
}

fn validate_under_data(
    data_root: &Path,
    destination: &Path,
    installation: &ResolvedInstallation,
) -> Result<(), String> {
    let data = installation
        .validate_data_root(data_root)
        .map_err(|_| "native_path_configuration_invalid".to_owned())?;
    let resolved = installation
        .validate_data_root(destination)
        .map_err(|_| "native_path_configuration_invalid".to_owned())?;
    if resolved.starts_with(&data) {
        Ok(())
    } else {
        Err("native_path_configuration_invalid".into())
    }
}
