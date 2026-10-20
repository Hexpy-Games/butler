//! Disposable native filesystem locks for cross-process E2E checks.
use std::{fs::File, io, path::Path};

/// Hold a file without delete sharing on Windows, allowing concurrent reads
/// and writes. Other hosts keep a read handle; callers probe unlink support.
pub fn deny_delete(path: &Path) -> io::Result<File> {
    #[cfg(windows)]
    {
        use std::os::windows::fs::OpenOptionsExt;
        File::options().read(true).share_mode(3).open(path)
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
            .share_mode(4)
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
                .access_mode(0x8001_0000)
                .share_mode(7)
                .custom_flags(0x0400_0000)
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
/// Restores the original descriptor even if the assertion panics.
pub fn with_read_denied<T>(path: &Path, action: impl FnOnce() -> T) -> io::Result<Option<T>> {
    #[cfg(windows)]
    return acl::with_read_denied(path, action).map(Some);
    #[cfg(not(windows))]
    {
        let _ = (path, action);
        Ok(None)
    }
}
