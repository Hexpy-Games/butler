//! Physical allocation accounting; unsupported hosts report unknown, never logical length.
use std::{io, path::Path};

/// Allocated file bytes. `None` means this platform cannot measure allocation.
pub fn allocated_bytes(path: &Path) -> io::Result<Option<u64>> {
    let metadata = std::fs::symlink_metadata(path)?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::MetadataExt;
        Ok(Some(metadata.blocks().saturating_mul(512)))
    }
    #[cfg(windows)]
    {
        let _ = metadata;
        Ok(None)
    }
}
