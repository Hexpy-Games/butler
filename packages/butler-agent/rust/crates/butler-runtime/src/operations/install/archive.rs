//! Safe extraction of an Agent `.tar.gz` into a fresh directory.
//!
//! An entry is written only when it is a regular file, a directory or a
//! relative symbolic link, and only inside the destination: no absolute or
//! `..` path, no repeated path, no write through a symbolic link, no link
//! that can lead out of the tree, and no hard link, device or other special
//! file. Files are created exclusively, so nothing that is already there is
//! overwritten or followed.

use std::collections::HashSet;
use std::fs::{self, File, OpenOptions};
use std::io::{self, Read};
use std::path::{Component, Path, PathBuf};

use butler_platform::{launcher, secure_fs};
use flate2::read::GzDecoder;
use tar::{Archive, Entry, EntryType};

use crate::operations::update::{UpdateCode, UpdateError};

const MAX_ENTRIES: usize = 50_000;
const MAX_TOTAL_BYTES: u64 = 4 << 30;
const GZIP_MAGIC: [u8; 2] = [0x1f, 0x8b];

/// Extracts the gzip-compressed tar archive at `archive` into `destination`,
/// an existing empty directory.
///
/// # Errors
///
/// `install_archive_format_unsupported` when the file is not a gzip tar,
/// `install_archive_unsafe` for an entry that breaks the rules above,
/// `install_archive_too_large`, or `install_write_failed`.
pub(super) fn extract(archive: &Path, destination: &Path) -> Result<(), UpdateError> {
    let mut file = File::open(archive)
        .map_err(|error| UpdateError::caused(UpdateCode::InstallWriteFailed, error))?;
    let mut magic = [0_u8; 2];
    if file.read_exact(&mut magic).is_err() || magic != GZIP_MAGIC {
        return Err(UpdateCode::InstallArchiveFormatUnsupported.into());
    }
    let file = File::open(archive)
        .map_err(|error| UpdateError::caused(UpdateCode::InstallWriteFailed, error))?;
    let mut tar = Archive::new(GzDecoder::new(file));
    let entries = tar.entries().map_err(unsafe_entry)?;
    let mut seen = HashSet::new();
    let mut total = 0_u64;
    for (index, entry) in entries.enumerate() {
        if index >= MAX_ENTRIES {
            return Err(UpdateCode::InstallArchiveTooLarge.into());
        }
        let mut entry = entry.map_err(unsafe_entry)?;
        let Some(relative) = entry_path(&entry)? else {
            continue;
        };
        if !seen.insert(relative.clone()) {
            return Err(UpdateCode::InstallArchiveUnsafe.into());
        }
        match entry.header().entry_type() {
            EntryType::Directory => make_directory(destination, &relative)?,
            EntryType::Regular | EntryType::Continuous => {
                total = total.saturating_add(entry.header().size().map_err(unsafe_entry)?);
                if total > MAX_TOTAL_BYTES {
                    return Err(UpdateCode::InstallArchiveTooLarge.into());
                }
                write_file(destination, &relative, &mut entry)?;
            }
            EntryType::Symlink => write_link(destination, &relative, &entry)?,
            _ => return Err(UpdateCode::InstallArchiveUnsafe.into()),
        }
    }
    Ok(())
}

/// The entry's path below the destination; `None` for the archive root
/// (`./`). Only plain components are allowed.
fn entry_path<R: Read>(entry: &Entry<'_, R>) -> Result<Option<PathBuf>, UpdateError> {
    let path = entry.path().map_err(unsafe_entry)?;
    let mut relative = PathBuf::new();
    for component in path.components() {
        match component {
            Component::CurDir => {}
            Component::Normal(part) => relative.push(part),
            _ => return Err(UpdateCode::InstallArchiveUnsafe.into()),
        }
    }
    Ok((!relative.as_os_str().is_empty()).then_some(relative))
}

fn make_directory(destination: &Path, relative: &Path) -> Result<(), UpdateError> {
    let parent = ensure_parents(destination, relative)?;
    let path = parent.join(file_name(relative)?);
    match fs::symlink_metadata(&path) {
        Ok(metadata) if metadata.is_dir() => Ok(()),
        Ok(_) => Err(UpdateCode::InstallArchiveUnsafe.into()),
        Err(error) if error.kind() == io::ErrorKind::NotFound => {
            fs::create_dir(&path).map_err(write_failed)
        }
        Err(error) => Err(write_failed(error)),
    }
}

fn write_file<R: Read>(
    destination: &Path,
    relative: &Path,
    entry: &mut Entry<'_, R>,
) -> Result<(), UpdateError> {
    let parent = ensure_parents(destination, relative)?;
    let path = parent.join(file_name(relative)?);
    let executable =
        secure_fs::FileMode::from_bits(entry.header().mode().unwrap_or(0)).is_executable();
    let mut file = OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&path)
        .map_err(write_failed)?;
    io::copy(entry, &mut file).map_err(write_failed)?;
    drop(file);
    if executable {
        launcher::mark_executable(&path)
            .transpose()
            .map_err(write_failed)?;
    }
    Ok(())
}

fn write_link<R: Read>(
    destination: &Path,
    relative: &Path,
    entry: &Entry<'_, R>,
) -> Result<(), UpdateError> {
    let parent = ensure_parents(destination, relative)?;
    let target = entry
        .link_name()
        .map_err(unsafe_entry)?
        .ok_or(UpdateCode::InstallArchiveUnsafe)?;
    let depth = relative.components().count().saturating_sub(1);
    if !link_stays_inside(&target, depth) {
        return Err(UpdateCode::InstallArchiveUnsafe.into());
    }
    secure_fs::symlink(&target, &parent.join(file_name(relative)?)).map_err(write_failed)
}

/// A link target that cannot lead out of the tree: relative, with `..` only
/// as a leading run. The link's own parents are real directories (see
/// [`ensure_parents`]), so the leading run may climb as high as the link is
/// deep (`depth` parent directories), and the remaining names only descend.
fn link_stays_inside(target: &Path, depth: usize) -> bool {
    let mut descending = false;
    let mut climb = 0_usize;
    let mut names = 0_usize;
    for component in target.components() {
        match component {
            Component::ParentDir if !descending => climb += 1,
            Component::Normal(_) => {
                descending = true;
                names += 1;
            }
            _ => return false,
        }
    }
    climb <= depth && (names > 0 || climb > 0)
}

/// Creates the missing directories above `relative` and returns the
/// destination path of its parent. A parent that exists as a symbolic link
/// or a file is refused: nothing is ever written through a link.
fn ensure_parents(destination: &Path, relative: &Path) -> Result<PathBuf, UpdateError> {
    let mut at = destination.to_path_buf();
    for component in relative.parent().into_iter().flat_map(Path::components) {
        at.push(component);
        match fs::symlink_metadata(&at) {
            Ok(metadata) if metadata.is_dir() => {}
            Ok(_) => return Err(UpdateCode::InstallArchiveUnsafe.into()),
            Err(error) if error.kind() == io::ErrorKind::NotFound => {
                fs::create_dir(&at).map_err(write_failed)?;
            }
            Err(error) => return Err(write_failed(error)),
        }
    }
    Ok(at)
}

fn file_name(relative: &Path) -> Result<&std::ffi::OsStr, UpdateError> {
    relative
        .file_name()
        .ok_or_else(|| UpdateCode::InstallArchiveUnsafe.into())
}

fn write_failed(error: io::Error) -> UpdateError {
    UpdateError::caused(UpdateCode::InstallWriteFailed, error)
}

/// A malformed archive entry (or a corrupt stream) is refused as unsafe.
fn unsafe_entry(error: io::Error) -> UpdateError {
    UpdateError::caused(UpdateCode::InstallArchiveUnsafe, error)
}
