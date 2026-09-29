//! A pointer file holding the version directory name.

use std::fs;
use std::io;
use std::path::Path;

use super::{is_plain_name, not_a_pointer};
use crate::secure_fs;

pub(super) fn point(home: &Path, link: &str, target: &str) -> io::Result<()> {
    let path = home.join(link);
    match fs::symlink_metadata(&path) {
        Ok(metadata) if !metadata.is_file() => return Err(not_a_pointer()),
        Ok(_) => {}
        Err(error) if error.kind() == io::ErrorKind::NotFound => {}
        Err(error) => return Err(error),
    }
    secure_fs::replace_private(
        &path,
        |file| io::Write::write_all(file, target.as_bytes()),
        std::convert::identity,
    )
}

pub(super) fn read(home: &Path, link: &str) -> io::Result<Option<String>> {
    let path = home.join(link);
    match fs::symlink_metadata(&path) {
        Ok(metadata) if metadata.is_file() => {}
        Ok(_) => return Err(not_a_pointer()),
        Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(None),
        Err(error) => return Err(error),
    }
    let name = fs::read_to_string(&path)?;
    let name = name.trim();
    if is_plain_name(name) {
        Ok(Some(name.to_owned()))
    } else {
        Err(not_a_pointer())
    }
}

pub(super) fn remove(home: &Path, link: &str) -> io::Result<()> {
    let path = home.join(link);
    match fs::symlink_metadata(&path) {
        Ok(metadata) if metadata.is_file() => fs::remove_file(&path),
        Ok(_) => Err(not_a_pointer()),
        Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(()),
        Err(error) => Err(error),
    }
}
