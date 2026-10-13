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
