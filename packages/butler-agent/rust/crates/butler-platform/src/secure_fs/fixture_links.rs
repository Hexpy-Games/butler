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

/// An equivalent native path spelling for public-path regression scenarios.
#[cfg(feature = "test-support")]
pub fn workspace_test_alias(path: &std::path::Path) -> std::path::PathBuf {
    #[cfg(windows)]
    {
        let text = path.to_string_lossy().to_uppercase();
        std::path::PathBuf::from(format!(r"\\?\{text}"))
    }
    #[cfg(not(windows))]
    {
        path.parent()
            .unwrap_or(path)
            .join(".")
            .join(path.file_name().unwrap_or_default())
    }
}
