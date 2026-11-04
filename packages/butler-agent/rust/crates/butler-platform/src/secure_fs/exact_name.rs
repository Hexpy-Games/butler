//! Exact leaf spelling on every filesystem, case-sensitive or not.
use std::{fs, io, path::Path};

/// Case-insensitive filesystems (Windows NTFS, case-insensitive APFS) resolve a
/// differently spelled name to the same entry, so the entry only counts when its
/// parent lists it under exactly this spelling. The listing runs only after the
/// entry resolves. Symlinks count as entries; the contained reader rejects links
/// and nonregular files separately before reading their contents.
pub fn exact_entry_exists(path: &Path) -> io::Result<bool> {
    match exact(path) {
        Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(false),
        result => result,
    }
}

fn exact(path: &Path) -> io::Result<bool> {
    fs::symlink_metadata(path)?;
    let (Some(parent), Some(name)) = (path.parent(), path.file_name()) else {
        return Ok(false);
    };
    for entry in fs::read_dir(parent)? {
        if entry?.file_name() == name {
            return Ok(true);
        }
    }
    Ok(false)
}
