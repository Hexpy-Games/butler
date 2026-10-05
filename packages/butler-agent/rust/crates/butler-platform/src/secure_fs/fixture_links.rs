//! Directory aliases for disposable filesystem fixtures without elevated privileges.
use std::{io, path::Path};

/// Create a directory reparse point on Windows, or a symbolic link on Unix.
/// Both resolve to the target when file tools canonicalize a parent path.
pub fn directory_alias(target: &Path, link: &Path) -> io::Result<()> {
    #[cfg(windows)]
    {
        let output = std::process::Command::new("cmd.exe")
            .args(["/d", "/c", "mklink", "/J"])
            .arg(link)
            .arg(target)
            .output()?;
        if output.status.success() {
            Ok(())
        } else {
            Err(io::Error::other(String::from_utf8_lossy(&output.stderr)))
        }
    }
    #[cfg(not(windows))]
    crate::secure_fs::symlink(target, link)
}
