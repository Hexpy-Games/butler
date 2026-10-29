use std::{
    fs::{self, DirBuilder, File},
    io,
    os::unix::fs::{DirBuilderExt, MetadataExt, PermissionsExt},
    path::{Path, PathBuf},
    sync::atomic::{AtomicU64, Ordering},
};

use rustix::fs::{CWD, Mode, OFlags, RenameFlags, openat, renameat_with};

#[cfg(test)]
#[path = "unix_tests.rs"]
mod tests;

fn directory(namespace: &str) -> io::Result<File> {
    let path = Path::new("/tmp").join(namespace);
    publish_directory(&path)?;
    let directory = File::from(openat(
        rustix::fs::CWD,
        &path,
        OFlags::RDONLY | OFlags::DIRECTORY | OFlags::NOFOLLOW | OFlags::CLOEXEC,
        Mode::empty(),
    )?);
    if directory.metadata()?.mode() & 0o7777 != 0o1777 {
        return Err(io::Error::new(
            io::ErrorKind::PermissionDenied,
            "shared lock directory must be sticky and world-writable",
        ));
    }
    Ok(directory)
}

struct UnpublishedDirectory(PathBuf);

impl Drop for UnpublishedDirectory {
    fn drop(&mut self) {
        let _ = fs::remove_dir(&self.0);
    }
}

fn publish_directory(path: &Path) -> io::Result<()> {
    static NEXT: AtomicU64 = AtomicU64::new(0);
    let namespace = path.file_name().ok_or_else(|| {
        io::Error::new(io::ErrorKind::InvalidInput, "lock directory needs a name")
    })?;
    let mut name = std::ffi::OsString::from(".");
    name.push(namespace);
    name.push(format!(
        ".tmp-{}-{}",
        std::process::id(),
        NEXT.fetch_add(1, Ordering::Relaxed)
    ));
    let temporary = path.with_file_name(name);
    DirBuilder::new().mode(0o700).create(&temporary)?;
    let temporary = UnpublishedDirectory(temporary);
    // Publish only after chmod: mkdir's requested mode is filtered by umask.
    fs::set_permissions(&temporary.0, fs::Permissions::from_mode(0o1777))?;
    match renameat_with(CWD, &temporary.0, CWD, path, RenameFlags::NOREPLACE) {
        Ok(()) | Err(rustix::io::Errno::EXIST) => Ok(()),
        Err(error) => Err(error.into()),
    }
}

pub(super) fn open(namespace: &str, name: &str) -> io::Result<File> {
    let directory = directory(namespace)?;
    let flags = OFlags::NOFOLLOW | OFlags::CLOEXEC | OFlags::NONBLOCK;
    let file = match openat(
        &directory,
        name,
        flags | OFlags::RDWR | OFlags::CREATE | OFlags::EXCL,
        Mode::from_raw_mode(0o444),
    ) {
        Ok(fd) => {
            let file = File::from(fd);
            file.set_permissions(fs::Permissions::from_mode(0o444))?;
            file
        }
        Err(rustix::io::Errno::EXIST) => {
            // flock supports read-only handles. Avoid O_CREAT on another user's
            // file (Linux protected_regular), and never alter existing files.
            File::from(openat(
                &directory,
                name,
                flags | OFlags::RDONLY,
                Mode::empty(),
            )?)
        }
        Err(error) => return Err(error.into()),
    };
    let metadata = file.metadata()?;
    if !metadata.is_file() || metadata.nlink() != 1 {
        return Err(io::Error::new(
            io::ErrorKind::InvalidData,
            "shared lock must be a regular file with one link",
        ));
    }
    Ok(file)
}
