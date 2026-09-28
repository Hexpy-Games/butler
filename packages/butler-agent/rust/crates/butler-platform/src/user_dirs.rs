//! The user's directories.
//!
//! Every host reads `HOME` first, so a caller (or a test) that sets `HOME`
//! decides the home directory everywhere; `USERPROFILE`, the Windows home,
//! is the fallback.

use std::env;
use std::path::PathBuf;

/// The user's home directory: `HOME`, else `USERPROFILE`, as set (an empty
/// value included); `None` when neither is set.
pub fn home_dir() -> Option<PathBuf> {
    env::var_os("HOME")
        .or_else(|| env::var_os("USERPROFILE"))
        .map(PathBuf::from)
}
