//! Read-only diagnostics for the permanent DATA-scoped kernel lock.

use std::{fs, fs::OpenOptions, io, path::Path};

use nix::{
    errno::Errno,
    fcntl::{Flock, FlockArg},
};

use super::instance_lock_path;

pub(crate) fn instance_lock_is_held_read_only(data_root: &Path) -> Result<bool, String> {
    let path = instance_lock_path(data_root);
    match fs::symlink_metadata(&path) {
        Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(false),
        Err(_) => return Err("service_lock_unavailable".into()),
        Ok(metadata) if metadata.file_type().is_symlink() || !metadata.is_file() => {
            return Err("service_lock_path_ambiguous".into());
        }
        Ok(_) => {}
    }
    let file = OpenOptions::new()
        .read(true)
        .open(path)
        .map_err(|_| "service_lock_unavailable".to_owned())?;
    match Flock::lock(file, FlockArg::LockSharedNonblock) {
        Ok(_) => Ok(false),
        Err((_, Errno::EAGAIN)) => Ok(true),
        Err((_, error)) => Err(format!("service_lock_probe_failed: {error}")),
    }
}
