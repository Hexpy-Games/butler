//! Move entries without following aliases, including across project/data mounts.
use std::os::unix::fs::PermissionsExt;
use std::{io, path::Path};

pub(super) fn move_entry(source: &Path, target: &Path) -> io::Result<()> {
    match std::fs::rename(source, target) {
        Ok(()) => Ok(()),
        Err(error) if error.kind() == io::ErrorKind::CrossesDevices => {
            copy_entry(source, target)?;
            let metadata = std::fs::symlink_metadata(source)?;
            if metadata.is_dir() {
                std::fs::remove_dir_all(source)
            } else {
                std::fs::remove_file(source)
            }
        }
        Err(error) => Err(error),
    }
}

fn copy_entry(source: &Path, target: &Path) -> io::Result<()> {
    let mut pending = vec![(source.to_path_buf(), target.to_path_buf())];
    while let Some((source, target)) = pending.pop() {
        let metadata = std::fs::symlink_metadata(&source)?;
        if metadata.file_type().is_symlink() {
            std::os::unix::fs::symlink(std::fs::read_link(source)?, &target)?;
        } else if metadata.is_dir() {
            std::fs::create_dir(&target)?;
            std::fs::set_permissions(&target, std::fs::Permissions::from_mode(0o700))?;
            for entry in std::fs::read_dir(source)? {
                let entry = entry?;
                pending.push((entry.path(), target.join(entry.file_name())));
            }
        } else if metadata.is_file() {
            std::fs::copy(source, &target)?;
            std::fs::set_permissions(&target, std::fs::Permissions::from_mode(0o600))?;
        } else {
            return Err(io::Error::other(
                "cannot quarantine a special filesystem entry across mounts",
            ));
        }
    }
    Ok(())
}
