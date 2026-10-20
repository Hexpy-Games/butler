//! Whole-file reads across atomic replacement, with bounded native retries.
#[cfg(not(windows))]
use std::fs;
use std::{io, path::Path};

use super::replace_retry::SHARING_ERRORS;

#[cfg(windows)]
mod windows;

/// Reads a whole old or new file across atomic replacement. Windows retries
/// sharing conflicts and confirmed delete-pending entries for at most 950 ms.
/// Missing files, invalid paths and actual permission denials remain errors.
/// This synchronous operation belongs on a blocking thread.
pub fn read_replaced_file(path: &Path) -> io::Result<Vec<u8>> {
    #[cfg(windows)]
    return windows::read(path);
    #[cfg(not(windows))]
    fs::read(path)
}

/// Only ACCESS_DENIED needs the delete-pending probe. Other failures must
/// retain their original error without probing or waiting.
pub fn read_retry_allowed(code: Option<i32>, delete_pending: impl FnOnce() -> bool) -> bool {
    match code {
        Some(code) if SHARING_ERRORS.contains(&code) => true,
        Some(5) => delete_pending(),
        _ => false,
    }
}
