//! Execute permission bits.

use std::fs::{self, Metadata};
use std::io;
use std::os::unix::fs::PermissionsExt;
use std::path::Path;

const EXECUTABLE: u32 = 0o755;
const EXECUTE_BITS: u32 = 0o111;

pub(super) fn mark_executable(path: &Path) -> io::Result<()> {
    fs::set_permissions(path, fs::Permissions::from_mode(EXECUTABLE))
}

pub(super) fn is_executable(metadata: &Metadata) -> bool {
    metadata.is_file() && metadata.permissions().mode() & EXECUTE_BITS != 0
}
