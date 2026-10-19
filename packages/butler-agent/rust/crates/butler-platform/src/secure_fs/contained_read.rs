//! Anchor every path component to an open directory, refusing symlinks.
use std::{
    fs::File,
    io,
    path::{Component, Path},
};

pub(super) fn open(root: &Path, relative: &Path, write: bool) -> io::Result<File> {
    if relative.as_os_str().is_empty()
        || relative
            .components()
            .any(|c| !matches!(c, Component::Normal(_)))
    {
        return Err(io::Error::other("unsafe_output_path"));
    }
    open_components(root, relative, write)
}
#[cfg(unix)]
fn open_components(root: &Path, relative: &Path, write: bool) -> io::Result<File> {
    use rustix::fs::{Mode, OFlags, open, openat};
    let mut directory = open(
        root,
        OFlags::RDONLY | OFlags::DIRECTORY | OFlags::NOFOLLOW | OFlags::CLOEXEC,
        Mode::empty(),
    )?;
    let mut components = relative.components().peekable();
    while let Some(component) = components.next() {
        let mut flags = OFlags::RDONLY | OFlags::NOFOLLOW | OFlags::CLOEXEC | OFlags::NONBLOCK;
        if components.peek().is_some() {
            flags |= OFlags::DIRECTORY;
        }
        if write && components.peek().is_none() {
            flags.remove(OFlags::RDONLY);
            flags |= OFlags::WRONLY;
        }
        directory = openat(
            &directory,
            Path::new(component.as_os_str()),
            flags,
            Mode::empty(),
        )?;
    }
    let file = File::from(directory);
    if !file.metadata()?.is_file() {
        return Err(io::Error::other("output_regular_files_only"));
    }
    Ok(file)
}
#[cfg(windows)]
fn open_components(root: &Path, relative: &Path, write: bool) -> io::Result<File> {
    // Hold every ancestor without write/delete sharing until the final file
    // is open. Windows file IDs are unavailable; metadata comparisons cannot
    // fence a parent swap. OPEN_REPARSE_POINT inspects the entry itself.
    let mut guards = Vec::new();
    for parent in root.ancestors().collect::<Vec<_>>().into_iter().rev() {
        guards.push(windows_guard(parent, true, false)?);
    }
    let mut path = root.to_path_buf();
    let mut components = relative.components().peekable();
    while let Some(component) = components.next() {
        path.push(component);
        let directory = components.peek().is_some();
        let file = windows_guard(&path, directory, write && !directory)?;
        if !directory {
            return Ok(file);
        }
        guards.push(file);
    }
    Err(io::Error::other("unsafe_output_path"))
}
#[cfg(windows)]
fn windows_guard(path: &Path, directory: bool, write: bool) -> io::Result<File> {
    use std::os::windows::fs::{MetadataExt, OpenOptionsExt};
    let mut options = std::fs::OpenOptions::new();
    options
        .read(!write)
        .write(write)
        .share_mode(if write { 7 } else { 1 })
        .custom_flags(0x0220_0000);
    if directory {
        options.access_mode(0);
    }
    let file = options.open(path)?;
    let metadata = file.metadata()?;
    if metadata.file_attributes() & 0x400 != 0
        || (directory && !metadata.is_dir())
        || (!directory && !metadata.is_file())
    {
        return Err(io::Error::other("output_regular_files_only"));
    }
    Ok(file)
}
