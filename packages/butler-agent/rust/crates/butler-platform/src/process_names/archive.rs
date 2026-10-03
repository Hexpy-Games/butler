//! ZIP copies hard links as files. Repair only byte-identical, verified code.
use std::{
    fs,
    io::{self, Read},
    path::Path,
};

const COMPARE_BUFFER_BYTES: usize = 64 * 1024;

/// Restore role links after the caller verifies the extracted App signature.
///
/// # Errors
/// Refuses missing, non-file or changed aliases, and propagates filesystem errors.
pub fn restore_archive_links(binary: &Path) -> io::Result<()> {
    let directory = binary
        .parent()
        .ok_or_else(|| io::Error::other("No binary directory"))?;
    let aliases = super::ROLES.map(|role| binary.with_file_name(role.file_name()));
    for alias in &aliases {
        if !fs::symlink_metadata(alias)?.is_file() || !identical(binary, alias)? {
            return Err(io::Error::other("Foreign archived process role alias"));
        }
    }
    let original = fs::metadata(directory)?.permissions();
    #[cfg(unix)]
    let writable = {
        let mut writable = original.clone();
        use std::os::unix::fs::PermissionsExt;
        writable.set_mode(original.mode() | 0o200);
        writable
    };
    // Windows does not honor the read-only attribute on directories.
    #[cfg(not(unix))]
    let writable = original.clone();
    fs::set_permissions(directory, writable)?;
    let result = (|| {
        for alias in aliases {
            super::verify_alias(binary, &alias).or_else(|_| {
                fs::remove_file(&alias)?;
                fs::hard_link(binary, &alias)
            })?;
        }
        super::prepare(binary)
    })();
    let restored = fs::set_permissions(directory, original);
    result.and(restored)
}

fn identical(left: &Path, right: &Path) -> io::Result<bool> {
    let mut remaining = fs::metadata(left)?.len();
    if remaining != fs::metadata(right)?.len() {
        return Ok(false);
    }
    let mut left = fs::File::open(left)?;
    let mut right = fs::File::open(right)?;
    let mut a = vec![0; COMPARE_BUFFER_BYTES];
    let mut b = vec![0; COMPARE_BUFFER_BYTES];
    while remaining > 0 {
        let count = usize::try_from(remaining.min(a.len() as u64)).map_err(io::Error::other)?;
        a.truncate(count);
        b.truncate(count);
        left.read_exact(&mut a)?;
        right.read_exact(&mut b)?;
        if a != b {
            return Ok(false);
        }
        remaining -= count as u64;
    }
    Ok(true)
}
