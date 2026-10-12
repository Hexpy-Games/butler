//! Shared parsing of user-entered file paths and command directories.
use std::{
    io,
    path::{Path, PathBuf},
};

/// Expand a home prefix and apply native rooted-path semantics before joining a workspace.
pub fn parse(root: &Path, requested: &str) -> io::Result<PathBuf> {
    let expanded = expand_home(requested, super::user_dirs::non_empty_home_dir().as_deref())?;
    #[cfg(windows)]
    let expanded = windows_rooted(&root.to_string_lossy(), &expanded)?.replace('/', "\\");
    let _ = root;
    Ok(PathBuf::from(expanded))
}

/// Expand only `~`, `~/` and `~\` (never another user's `~name`).
pub fn expand_home(requested: &str, home: Option<&Path>) -> io::Result<String> {
    let suffix = if requested == "~" {
        ""
    } else if let Some(suffix) = requested
        .strip_prefix("~/")
        .or_else(|| requested.strip_prefix("~\\"))
    {
        suffix
    } else {
        return Ok(requested.to_owned());
    };
    let home = home.ok_or_else(|| {
        io::Error::new(
            io::ErrorKind::NotFound,
            "User home directory is unavailable",
        )
    })?;
    // Append rather than join: an extra separator must not replace the home root.
    Ok(format!(
        "{}/{}",
        home.display(),
        suffix.trim_start_matches(['/', '\\'])
    ))
}

/// Resolve a Windows root without a drive against the workspace's drive or UNC share.
/// Pure string parsing makes Windows contracts runnable on any host.
pub fn windows_rooted(root: &str, requested: &str) -> io::Result<String> {
    let path = requested.replace('\\', "/");
    if path.starts_with("//") {
        return Ok(path);
    }
    if path.as_bytes().get(1) == Some(&b':') {
        if path.as_bytes().get(2) != Some(&b'/') {
            return Err(io::Error::new(
                io::ErrorKind::InvalidInput,
                "Drive-relative paths are ambiguous; use a drive-qualified absolute path",
            ));
        }
        return Ok(path);
    }
    if !path.starts_with('/') {
        return Ok(path);
    }
    let root = root.replace('\\', "/");
    let root = root
        .strip_prefix("//?/UNC/")
        .map(|unc| format!("//{unc}"))
        .unwrap_or_else(|| root.strip_prefix("//?/").unwrap_or(&root).to_owned());
    let prefix = if root.as_bytes().get(1) == Some(&b':') {
        root.get(..2)
    } else if let Some(unc) = root.strip_prefix("//") {
        let mut parts = unc.split('/');
        match (parts.next(), parts.next()) {
            (Some(server), Some(share)) if !server.is_empty() && !share.is_empty() => {
                root.get(..2 + server.len() + 1 + share.len())
            }
            _ => None,
        }
    } else {
        None
    };
    let prefix = prefix.ok_or_else(|| {
        io::Error::new(
            io::ErrorKind::InvalidInput,
            "Workspace has no Windows drive or UNC share for this rooted path",
        )
    })?;
    Ok(format!("{prefix}{path}"))
}

/// Whether a string has a Windows absolute or drive-less rooted prefix.
pub fn has_windows_root(value: &str) -> bool {
    value.starts_with('\\')
        || value.starts_with("//")
        || value
            .as_bytes()
            .first()
            .is_some_and(u8::is_ascii_alphabetic)
            && value.as_bytes().get(1) == Some(&b':')
            && matches!(value.as_bytes().get(2), Some(b'/' | b'\\'))
}

/// Normalize discovery separators without turning a drive root into a drive-relative path.
pub fn discovery_root(value: &str) -> String {
    let slash = value.replace('\\', "/");
    let slash = slash.strip_prefix("./").unwrap_or(&slash);
    let trimmed = slash.trim_end_matches('/');
    if trimmed.is_empty() && slash.starts_with('/') {
        "/".into()
    } else if trimmed.len() == 2 && trimmed.as_bytes().get(1) == Some(&b':') && slash.ends_with('/')
    {
        format!("{trimmed}/")
    } else if trimmed.is_empty() {
        ".".into()
    } else {
        trimmed.into()
    }
}
