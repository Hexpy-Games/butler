//! Native hidden flags, independent of dot-prefixed names.
use std::fs::Metadata;

/// Whether the filesystem marks an entry as hidden.
pub fn is_hidden(metadata: &Metadata) -> bool {
    #[cfg(target_os = "macos")]
    {
        use std::os::macos::fs::MetadataExt;
        metadata.st_flags() & 0x8000 != 0
    }
    #[cfg(windows)]
    {
        use std::os::windows::fs::MetadataExt;
        metadata.file_attributes() & 0x2 != 0
    }
    #[cfg(not(any(target_os = "macos", windows)))]
    {
        let _ = metadata;
        false
    }
}
