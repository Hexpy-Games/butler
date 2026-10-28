//! Persistent, non-secret lock files shared across isolated processes.

use std::{fs::File, io, path::Path};

#[cfg(unix)]
mod unix;
#[cfg(unix)]
use unix as sys;
#[cfg(windows)]
mod windows;
#[cfg(windows)]
use windows as sys;

/// Opens a reusable lock file; callers hold an instance lock on the handle.
///
/// Unix uses a sticky, world-writable directory under `/tmp`, independent of
/// environment overrides. Files are readable by all users and contain no data.
/// Windows retains temp-directory isolation to respect runner write boundaries.
/// Files must never be unlinked: replacing an inode would split its leases.
pub fn open(namespace: &str, name: &str) -> io::Result<File> {
    for component in [namespace, name] {
        if Path::new(component).file_name() != Some(component.as_ref()) {
            return Err(io::Error::new(
                io::ErrorKind::InvalidInput,
                "lock namespace and name must each be a single path component",
            ));
        }
    }
    sys::open(namespace, name)
}
