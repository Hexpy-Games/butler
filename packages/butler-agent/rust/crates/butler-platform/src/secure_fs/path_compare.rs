//! Component-wise native path comparison, retaining the target spelling.
use std::path::{Path, PathBuf};

/// The target relative to the root, ignoring Windows case and verbatim syntax.
/// Callers must resolve filesystem aliases before using this for containment.
pub fn relative_path(target: &Path, root: &Path) -> Option<PathBuf> {
    #[cfg(windows)]
    {
        if !is_within(target, root) {
            return None;
        }
        Some(
            target
                .components()
                .skip(root.components().count())
                .collect(),
        )
    }
    #[cfg(not(windows))]
    {
        target.strip_prefix(root).ok().map(Path::to_path_buf)
    }
}

// Containment checks need no allocation for an unused relative suffix.
pub(super) fn is_within(target: &Path, root: &Path) -> bool {
    #[cfg(windows)]
    {
        comparison_key(target).starts_with(comparison_key(root))
    }
    #[cfg(not(windows))]
    {
        target.starts_with(root)
    }
}

#[cfg(windows)]
fn comparison_key(path: &Path) -> PathBuf {
    let text = path.to_string_lossy().replace('\\', "/").to_lowercase();
    if let Some(unc) = text.strip_prefix("//?/unc/") {
        PathBuf::from(format!("//{unc}"))
    } else {
        PathBuf::from(text.strip_prefix("//?/").unwrap_or(&text))
    }
}
