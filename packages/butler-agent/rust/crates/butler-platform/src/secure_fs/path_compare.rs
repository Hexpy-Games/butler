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

/// Reject Windows aliases that cannot be safely classified lexically.
pub fn windows_ambiguous_spelling(text: &str) -> bool {
    let normalized = text.replace('\\', "/").to_ascii_lowercase();
    if normalized.starts_with("//./")
        || normalized.starts_with("//?/globalroot")
        || normalized.starts_with("/??/")
    {
        return true;
    }
    let value = normalized.strip_prefix("//?/").unwrap_or(&normalized);
    let bytes = value.as_bytes();
    let drive = matches!(bytes, [d, b':', ..] if d.is_ascii_alphabetic());
    if drive && bytes.get(2) != Some(&b'/') {
        return true;
    }
    let rest = if drive {
        value.get(2..).unwrap_or("")
    } else {
        value
    };
    rest.split('/').any(|part| {
        if part == "." || part == ".." {
            return false;
        }
        if part.contains(':') || part.ends_with(['.', ' ']) {
            return true;
        }
        let stem = part.split('.').next().unwrap_or("");
        if matches!(stem, "con" | "prn" | "aux" | "nul") {
            return true;
        }
        if stem.len() == 4
            && (stem.starts_with("com") || stem.starts_with("lpt"))
            && matches!(stem.as_bytes().get(3), Some(b'1'..=b'9'))
        {
            return true;
        }
        stem.split_once('~').is_some_and(|(prefix, digits)| {
            (1..=6).contains(&prefix.len())
                && !digits.is_empty()
                && digits.bytes().all(|byte| byte.is_ascii_digit())
        })
    })
}
/// Alias protection is needed only on Windows; case mismatches on macOS
/// conservatively classify outside rather than granting a false containment.
pub fn ambiguous_path(path: &Path) -> bool {
    #[cfg(windows)]
    {
        windows_ambiguous_spelling(&path.to_string_lossy())
    }
    #[cfg(not(windows))]
    {
        let _ = path;
        false
    }
}
