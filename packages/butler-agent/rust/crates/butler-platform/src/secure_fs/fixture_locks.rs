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
