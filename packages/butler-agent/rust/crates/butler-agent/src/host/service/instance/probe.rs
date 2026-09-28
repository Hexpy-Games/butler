//! Read-only diagnostics for the permanent DATA-scoped kernel lock.

use std::{fs, fs::OpenOptions, io, path::Path};

use butler_platform::instance::{InstanceLock, LockError};

use super::instance_lock_path;

pub(crate) fn instance_lock_is_held_read_only(
    data_root: &Path,
) -> Result<bool, crate::host::HostError> {
    let path = instance_lock_path(data_root);
    match fs::symlink_metadata(&path) {
        Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(false),
        Err(_) => return Err("service_lock_unavailable".into()),
        Ok(metadata) if metadata.file_type().is_symlink() || !metadata.is_file() => {
            return Err("service_lock_path_ambiguous".into());
        }
        Ok(_) => {}
    }
    let file = OpenOptions::new().read(true).open(path).map_err(|source| {
        crate::host::HostError::new("service_lock_unavailable").with_source(source)
    })?;
    match InstanceLock::try_shared(file) {
        Ok(_) => Ok(false),
        Err(LockError::Busy) => Ok(true),
        Err(LockError::Failed(error)) => Err(format!("service_lock_probe_failed: {error}").into()),
    }
}
