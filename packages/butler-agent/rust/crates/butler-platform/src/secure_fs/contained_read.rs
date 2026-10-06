//! Anchor every path component to an open directory, refusing symlinks.
use std::{
    fs::File,
    io,
    path::{Component, Path},
};

pub(super) fn open(root: &Path, relative: &Path) -> io::Result<File> {
    if relative.as_os_str().is_empty()
        || relative
            .components()
            .any(|c| !matches!(c, Component::Normal(_)))
    {
        return Err(io::Error::other("unsafe_output_path"));
    }
    open_components(root, relative)
}
#[cfg(unix)]
fn open_components(root: &Path, relative: &Path) -> io::Result<File> {
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
fn open_components(root: &Path, relative: &Path) -> io::Result<File> {
    let mut path = root.to_path_buf();
    let mut parents = Vec::new();
    for component in relative.components() {
        path.push(component);
        let metadata = std::fs::symlink_metadata(&path)?;
        if metadata.file_type().is_symlink() {
            return Err(io::Error::other("output_symlink_refused"));
        }
        parents.push((path.clone(), super::identity(&metadata)));
    }
    let file = super::open_read_no_follow(&path)?;
    if !file.metadata()?.is_file() {
        return Err(io::Error::other("output_regular_files_only"));
    }
    for (path, before) in parents {
        if super::identity(&std::fs::symlink_metadata(path)?) != before {
            return Err(io::Error::other("output_path_changed"));
        }
    }
    Ok(file)
}
