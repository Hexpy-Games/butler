//! Containment checks for paths that may mutate Cognition state.

use std::{
    ffi::OsString,
    fs,
    path::{Component, Path, PathBuf},
};

use super::{CognitionError, CognitionResult};

pub(crate) fn ensure_data_authority(
    data_root: &Path,
    descendants: &[&Path],
) -> CognitionResult<()> {
    let canonical_data = canonicalize_nearest_existing(data_root)?;
    for descendant in descendants {
        if !canonicalize_nearest_existing(descendant)?.starts_with(&canonical_data) {
            return Err(unsafe_path());
        }
    }
    Ok(())
}

fn canonicalize_nearest_existing(path: &Path) -> CognitionResult<PathBuf> {
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
    let mut resolved = fs::canonicalize(ancestor).map_err(|_| unsafe_path())?;
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

fn unsafe_path() -> CognitionError {
    CognitionError::new(
        "memory_data_path_unsafe",
        "Cognition path is outside mutable DATA",
    )
}
