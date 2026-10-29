//! Read-only package content and explicit user-requested removal.
use std::{fs, io, path::Path};
/// Change package permissions without following links.
pub fn protect(root: &Path, readonly: bool) -> io::Result<()> {
    let metadata = fs::symlink_metadata(root)?;
    if metadata.is_symlink() {
        return Err(io::Error::other("package_symlink"));
    }
    if metadata.is_dir() {
        if !readonly {
            permissions(root, &metadata, false)?;
        }
        for entry in fs::read_dir(root)? {
            protect(&entry?.path(), readonly)?;
        }
    }
    permissions(root, &metadata, readonly)
}
fn permissions(path: &Path, metadata: &fs::Metadata, readonly: bool) -> io::Result<()> {
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let executable = metadata.permissions().mode() & 0o111 != 0;
        let mode = if readonly {
            if metadata.is_dir() || executable {
                0o500
            } else {
                0o400
            }
        } else if metadata.is_dir() || executable {
            0o700
        } else {
            0o600
        };
        fs::set_permissions(path, fs::Permissions::from_mode(mode))
    }
    #[cfg(windows)]
    {
        let mut permissions = metadata.permissions();
        permissions.set_readonly(readonly);
        fs::set_permissions(path, permissions)
    }
}
/// Remove an immutable package after a user action.
pub fn remove(root: &Path) -> io::Result<()> {
    let meta = match fs::symlink_metadata(root) {
        Ok(meta) => meta,
        Err(e) if e.kind() == io::ErrorKind::NotFound => return Ok(()),
        Err(e) => return Err(e),
    };
    if meta.is_symlink() {
        return fs::remove_file(root);
    }
    permissions(root, &meta, false)?;
    if meta.is_dir() {
        for entry in fs::read_dir(root)? {
            remove(&entry?.path())?;
        }
        fs::remove_dir(root)
    } else {
        fs::remove_file(root)
    }
}

/// Portable digest mode: executable or ordinary, independent of access permissions.
pub fn mode(metadata: &fs::Metadata) -> String {
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        if metadata.permissions().mode() & 0o111 != 0 {
            "755".into()
        } else {
            "644".into()
        }
    }
    #[cfg(windows)]
    {
        let _ = metadata;
        "644".into()
    }
}

/// Git records executable intent on platforms whose checkout cannot represent it.
pub fn git_mode(checkout_mode: &str, index_mode: Option<&str>) -> String {
    #[cfg(windows)]
    {
        index_mode.unwrap_or(checkout_mode).to_owned()
    }
    #[cfg(not(windows))]
    {
        let _ = index_mode;
        checkout_mode.to_owned()
    }
}
