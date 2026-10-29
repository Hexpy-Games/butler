use std::{
    fs::{self, DirBuilder, File},
    io,
    os::unix::fs::{DirBuilderExt, MetadataExt, PermissionsExt},
    path::Path,
};

use rustix::fs::{Mode, OFlags, openat};

fn directory(namespace: &str) -> io::Result<File> {
    let path = Path::new("/tmp").join(namespace);
    let created = match DirBuilder::new().mode(0o1777).create(&path) {
        Ok(()) => true,
        Err(error) if error.kind() == io::ErrorKind::AlreadyExists => false,
        Err(error) => return Err(error),
    };
    let directory = File::from(openat(
        rustix::fs::CWD,
        &path,
        OFlags::RDONLY | OFlags::DIRECTORY | OFlags::NOFOLLOW | OFlags::CLOEXEC,
        Mode::empty(),
    )?);
    if created {
        // Only the directory we created is widened, regardless of umask.
        directory.set_permissions(fs::Permissions::from_mode(0o1777))?;
    }
    if directory.metadata()?.mode() & 0o7777 != 0o1777 {
        return Err(io::Error::new(
            io::ErrorKind::PermissionDenied,
            "shared lock directory must be sticky and world-writable",
        ));
    }
    Ok(directory)
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
