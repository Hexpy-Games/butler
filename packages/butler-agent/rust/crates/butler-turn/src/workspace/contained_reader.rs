//! The filesystem boundary for project reads and edit read-back.
use super::PathForm;
use butler_platform::{secure_fs, secure_fs::SecretInventory};
use std::{fs::File, io, path::Path};

pub(super) fn open(root: &Path, path: &str, form: PathForm, data: &Path) -> io::Result<File> {
    let requested = butler_platform::tool_paths::parse(root, path)?;
    if !form.contained() {
        return File::open(root.join(requested));
    }
    let relative = if requested.is_absolute() {
        secure_fs::relative_path(&requested, root)
            .ok_or_else(|| io::Error::new(io::ErrorKind::PermissionDenied, "path_escape"))?
    } else {
        requested
    };
    secure_fs::open_contained(root, &relative, &SecretInventory::cached(data))
}
