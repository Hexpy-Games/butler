//! Windows runs files by their extension; there are no execute bits.

use std::fs::Metadata;
use std::io;
use std::path::Path;

pub(super) fn mark_executable(_path: &Path) -> io::Result<()> {
    Ok(())
}

pub(super) fn is_executable(metadata: &Metadata) -> bool {
    metadata.is_file()
}
