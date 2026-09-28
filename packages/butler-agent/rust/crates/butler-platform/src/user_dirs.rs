//! The user's directories, and the system's.
//!
//! Every host reads `HOME` first, so a caller (or a test) that sets `HOME`
//! decides the home directory everywhere; `USERPROFILE`, the Windows home,
//! is the fallback.

use std::env;
use std::path::{Path, PathBuf};

/// The user's home directory: `HOME`, else `USERPROFILE`, as set (an empty
/// value included); `None` when neither is set.
pub fn home_dir() -> Option<PathBuf> {
    env::var_os("HOME")
        .or_else(|| env::var_os("USERPROFILE"))
        .map(PathBuf::from)
}

/// [`home_dir`], unless it is set but empty.
pub fn non_empty_home_dir() -> Option<PathBuf> {
    home_dir().filter(|home| !home.as_os_str().is_empty())
}

/// Whether `path` is a file-system root or lies in the operating system's
/// own folders, which no user project may claim: `/` and `/System`, `/etc`,
/// `/private/etc`, `/bin`, `/sbin` on Unix; a drive root and the
/// `SystemRoot`, `ProgramFiles` and `ProgramFiles(x86)` folders on Windows.
pub fn is_system_folder(path: &Path) -> bool {
    if path.has_root() && path.parent().is_none() {
        return true;
    }
    system_roots().iter().any(|root| path.starts_with(root))
}

#[cfg(unix)]
fn system_roots() -> Vec<PathBuf> {
    ["/System", "/etc", "/private/etc", "/bin", "/sbin"]
        .into_iter()
        .map(PathBuf::from)
        .collect()
}

#[cfg(windows)]
fn system_roots() -> Vec<PathBuf> {
    ["SystemRoot", "ProgramFiles", "ProgramFiles(x86)"]
        .into_iter()
        .filter_map(env::var_os)
        .filter(|root| !root.is_empty())
        .map(PathBuf::from)
        .collect()
}
