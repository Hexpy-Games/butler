//! Disposable native filesystem locks for cross-process E2E checks.
use std::{fs::File, io, path::Path};

#[cfg(windows)]
const FILE_SHARE_READ: u32 = 1;
#[cfg(windows)]
const FILE_SHARE_WRITE: u32 = 2;
#[cfg(windows)]
const FILE_SHARE_DELETE: u32 = 4;
#[cfg(windows)]
const GENERIC_READ: u32 = 0x8000_0000;
#[cfg(windows)]
const DELETE: u32 = 0x0001_0000;
#[cfg(windows)]
const FILE_FLAG_DELETE_ON_CLOSE: u32 = 0x0400_0000;

/// Hold a file without delete sharing on Windows, allowing concurrent reads
/// and writes. Other hosts keep a read handle; callers probe unlink support.
pub fn deny_delete(path: &Path) -> io::Result<File> {
    #[cfg(windows)]
    {
        use std::os::windows::fs::OpenOptionsExt;
        File::options()
            .read(true)
            .share_mode(FILE_SHARE_READ | FILE_SHARE_WRITE)
            .open(path)
    }
    #[cfg(not(windows))]
    File::open(path)
}

/// Temporarily deny new readers while still permitting atomic replacement.
/// Returns `None` on hosts without native sharing modes.
pub fn deny_read(path: &Path) -> io::Result<Option<File>> {
    #[cfg(windows)]
    {
        use std::os::windows::fs::OpenOptionsExt;
        File::options()
            .read(true)
            .share_mode(FILE_SHARE_DELETE)
            .open(path)
            .map(Some)
    }
    #[cfg(not(windows))]
    {
        let _ = path;
        Ok(None)
    }
}

/// Hold a legacy delete-pending entry until this handle closes.
pub fn pending_delete(path: &Path) -> io::Result<Option<File>> {
    #[cfg(windows)]
    {
        use std::os::windows::fs::OpenOptionsExt;
        let held = File::open(path)?;
        // DELETE_ON_CLOSE is applied when this second handle closes; the
        // first handle keeps the deleted entry pending rather than absent.
        drop(
            File::options()
                .read(true)
                .access_mode(GENERIC_READ | DELETE)
                .share_mode(FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE)
                .custom_flags(FILE_FLAG_DELETE_ON_CLOSE)
                .open(path)?,
        );
        Ok(Some(held))
    }
    #[cfg(not(windows))]
    {
        let _ = path;
        Ok(None)
    }
}

#[cfg(windows)]
mod acl;

/// Run a disposable fixture with read access explicitly denied by its DACL.
/// The callback receives the native delete-pending probe result while denied.
/// Restores the original descriptor even if the assertion panics.
pub fn with_read_denied<T>(path: &Path, action: impl FnOnce(bool) -> T) -> io::Result<Option<T>> {
    #[cfg(windows)]
    return acl::with_read_denied(path, || {
        action(super::read_retry::windows::delete_pending(path))
    })
    .map(Some);
    #[cfg(not(windows))]
    {
        let _ = (path, action);
        Ok(None)
    }
}

/// Classifies ACCESS_DENIED using native permission probes, without needing an
/// antivirus or mapped-view race to produce that error deterministically.
pub fn access_denied_rename_is_transient(from: &Path, to: &Path) -> Option<bool> {
    #[cfg(windows)]
    {
        Some(super::sys::replacement_is_transient(
            &io::Error::from_raw_os_error(5),
            from,
            to,
        ))
    }
    #[cfg(not(windows))]
    {
        let _ = (from, to);
        None
    }
}
