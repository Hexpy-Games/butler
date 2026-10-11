//! Firefox leaves lock files behind; inspect the lock instead of marker existence.
use super::{ImportError, io_error};
use std::fs::File;
use std::path::Path;

pub(super) fn check(path: &Path) -> Result<(), ImportError> {
    let file = match File::open(path) {
        Ok(file) => file,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(()),
        Err(e) => return Err(io_error(&e)),
    };
    #[cfg(unix)]
    {
        use nix::fcntl::{FcntlArg, fcntl};
        let mut lock = unix_lock()?;
        fcntl(&file, FcntlArg::F_GETLK(&mut lock)).map_err(|_| ImportError::Locked)?;
        if lock.l_pid != 0 {
            return Err(ImportError::Locked);
        }
    }
    #[cfg(not(unix))]
    file.try_lock().map_err(|_| ImportError::Locked)?;
    Ok(())
}

#[cfg(unix)]
fn unix_lock() -> Result<nix::libc::flock, ImportError> {
    use nix::libc;
    #[cfg(target_os = "macos")]
    let lock_type = libc::F_WRLCK;
    #[cfg(not(target_os = "macos"))]
    let lock_type = i16::try_from(libc::F_WRLCK).map_err(|_| ImportError::Format)?;
    Ok(libc::flock {
        l_start: 0,
        l_len: 0,
        l_pid: 0,
        l_type: lock_type,
        l_whence: i16::try_from(libc::SEEK_SET).map_err(|_| ImportError::Format)?,
    })
}

#[cfg(feature = "test-support")]
/// Hold a real profile lock in the fixture process until the returned file is dropped.
pub fn fixture_profile_lock(path: &Path) -> std::io::Result<File> {
    let file = File::options()
        .create(true)
        .truncate(false)
        .read(true)
        .write(true)
        .open(path)?;
    #[cfg(unix)]
    {
        use nix::fcntl::{FcntlArg, fcntl};
        let lock = unix_lock().map_err(std::io::Error::other)?;
        fcntl(&file, FcntlArg::F_SETLK(&lock)).map_err(std::io::Error::from)?;
    }
    #[cfg(not(unix))]
    file.try_lock().map_err(std::io::Error::other)?;
    Ok(file)
}
