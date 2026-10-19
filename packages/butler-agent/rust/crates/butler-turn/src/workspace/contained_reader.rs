//! The filesystem boundary for project reads and edit read-back.
use super::PathForm;
use butler_platform::{secure_fs, secure_fs::SecretInventory};
use std::{fs::File, io, path::Path};

pub(super) fn open(root: &Path, path: &str, form: PathForm, data: &Path) -> io::Result<File> {
    open_cached(root, path, form, data, None)
}
pub(super) fn open_cached(
    root: &Path,
    path: &str,
    form: PathForm,
    data: &Path,
    cache: Option<&secure_fs::ContainedReadCache>,
) -> io::Result<File> {
    open_protected(root, path, form, data, cache, &[])
}
pub(super) fn open_protected(
    root: &Path,
    path: &str,
    form: PathForm,
    data: &Path,
    cache: Option<&secure_fs::ContainedReadCache>,
    protected: &[std::path::PathBuf],
) -> io::Result<File> {
    let requested = butler_platform::tool_paths::parse(root, path)?;
    if form == PathForm::RelativeOnly
        && (requested.is_absolute()
            || requested
                .components()
                .any(|part| matches!(part, std::path::Component::ParentDir)))
    {
        return Err(io::Error::new(
            io::ErrorKind::PermissionDenied,
            "contained_read_refused",
        ));
    }
    if !form.contained() {
        return File::open(root.join(requested));
    }
    let relative = if requested.is_absolute() {
        secure_fs::relative_path(&requested, root)
            .ok_or_else(|| io::Error::new(io::ErrorKind::PermissionDenied, "path_escape"))?
    } else {
        requested
    };
    match cache {
        Some(cache) => cache.open_for_data(root, &relative, data, protected),
        None => secure_fs::ContainedReadCache::default().open_protected(
            root,
            &relative,
            &SecretInventory::cached(data),
            protected,
        ),
    }
}
