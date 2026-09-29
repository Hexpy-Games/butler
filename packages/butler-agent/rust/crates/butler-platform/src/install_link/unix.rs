//! Relative symbolic links, switched with a rename.

use std::fs;
use std::io;
use std::path::{Path, PathBuf};

use super::{is_plain_name, not_a_pointer};
use crate::secure_fs;

pub(super) fn point(home: &Path, link: &str, target: &str) -> io::Result<()> {
    let path = home.join(link);
    match fs::symlink_metadata(&path) {
        Ok(metadata) if !metadata.file_type().is_symlink() => return Err(not_a_pointer()),
        Ok(_) => {}
        Err(error) if error.kind() == io::ErrorKind::NotFound => {}
        Err(error) => return Err(error),
    }
    let staged = staging_path(home, link);
    let _ = fs::remove_file(&staged);
    secure_fs::symlink(Path::new(target), &staged)?;
    if let Err(error) = fs::rename(&staged, &path) {
        let _ = fs::remove_file(&staged);
        return Err(error);
    }
    secure_fs::sync_directory(home).unwrap_or(Ok(()))
}

pub(super) fn read(home: &Path, link: &str) -> io::Result<Option<String>> {
    let path = home.join(link);
    match fs::symlink_metadata(&path) {
        Ok(metadata) if metadata.file_type().is_symlink() => {}
        Ok(_) => return Err(not_a_pointer()),
        Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(None),
        Err(error) => return Err(error),
    }
    let target = fs::read_link(&path)?;
    let name = target.to_str().filter(|name| is_plain_name(name));
    name.map(|name| Some(name.to_owned()))
        .ok_or_else(not_a_pointer)
}

pub(super) fn remove(home: &Path, link: &str) -> io::Result<()> {
    let path = home.join(link);
    match fs::symlink_metadata(&path) {
        Ok(metadata) if metadata.file_type().is_symlink() => fs::remove_file(&path),
        Ok(_) => Err(not_a_pointer()),
        Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(()),
        Err(error) => Err(error),
    }
}

fn staging_path(home: &Path, link: &str) -> PathBuf {
    home.join(format!(".{link}.switch-{}", std::process::id()))
}
