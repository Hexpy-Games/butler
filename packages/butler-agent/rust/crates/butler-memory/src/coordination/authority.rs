//! Containment checks for paths that may mutate Cognition state.

use std::{
    ffi::OsString,
    fs,
    path::{Component, Path, PathBuf},
};

use std::io;

/// Checks that each path resolves inside `data_root` without following links out of it.
pub(crate) fn ensure_data_authority(data_root: &Path, descendants: &[&Path]) -> io::Result<()> {
    let canonical_data = canonicalize_nearest_existing(data_root)?;
    for descendant in descendants {
        if !canonicalize_nearest_existing(descendant)?.starts_with(&canonical_data) {
            return Err(unsafe_path());
        }
    }
    Ok(())
}

fn canonicalize_nearest_existing(path: &Path) -> io::Result<PathBuf> {
    let absolute = if path.is_absolute() {
        path.to_path_buf()
    } else {
        std::env::current_dir()
            .map_err(|_| unsafe_path())?
            .join(path)
    };
    let mut ancestor = absolute.as_path();
    let mut suffix: Vec<OsString> = Vec::new();
    loop {
        match fs::symlink_metadata(ancestor) {
            Ok(_) => break,
            Err(io_error) if io_error.kind() == std::io::ErrorKind::NotFound => {
                let component = ancestor
                    .components()
                    .next_back()
                    .filter(|component| {
                        !matches!(component, Component::RootDir | Component::Prefix(_))
                    })
                    .ok_or_else(unsafe_path)?;
                suffix.push(component.as_os_str().to_owned());
                ancestor = ancestor.parent().ok_or_else(unsafe_path)?;
            }
            Err(_) => return Err(unsafe_path()),
        }
    }
    let mut resolved =
        butler_platform::secure_fs::canonicalize(ancestor).map_err(|_| unsafe_path())?;
    for component in suffix.iter().rev() {
        match Path::new(component).components().next() {
            Some(Component::Normal(name)) => resolved.push(name),
            Some(Component::ParentDir) => {
                resolved.pop();
            }
            Some(Component::CurDir) => {}
            Some(Component::RootDir | Component::Prefix(_)) | None => {
                return Err(unsafe_path());
            }
        }
    }
    Ok(resolved)
}

fn unsafe_path() -> io::Error {
    io::Error::other("Memory path is outside mutable DATA")
}

pub(crate) fn ensure_supported_data_authority(
    root: &Path,
    descendants: &[&Path],
) -> io::Result<()> {
    if !root.join("agent-runtime/btcc.sqlite").exists()
        && root.join("app-server/butler-client.sqlite").exists()
    {
        return Err(io::Error::other("Legacy data folder is unsupported"));
    }
    ensure_data_authority(root, descendants)
}
