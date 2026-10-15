//! Exact hard-link identity; size and timestamps are never evidence of identity.
use std::{io, path::Path};

/// Whether two paths identify the same inode or Windows file ID.
pub fn same_file(left: &Path, right: &Path) -> io::Result<bool> {
    #[cfg(unix)]
    {
        let a = super::identity(&std::fs::metadata(left)?).id;
        let b = super::identity(&std::fs::metadata(right)?).id;
        Ok(a.is_some() && a == b)
    }
    #[cfg(windows)]
    {
        same_file::is_same_file(left, right)
    }
}

/// Whether two metadata describe the same file: the same [`FileId`]; without
/// [`FILE_IDS`], the same length and modification time.
pub fn same_metadata(left: &std::fs::Metadata, right: &std::fs::Metadata) -> bool {
    match (super::identity(left).id, super::identity(right).id) {
        (Some(left), Some(right)) => left == right,
        _ => left.len() == right.len() && left.modified().ok() == right.modified().ok(),
    }
}
