//! Only fresh roots or a conservative, bounded startup migration acquire ownership.
use super::data_reset::plan;
use butler_platform::secure_fs::{self, Canonical as _};
use serde::{Deserialize, Serialize};
use std::{fs, io, path::Path};

pub(crate) const MARKER: &str = "state/data-root-owner.json";
#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct Owner {
    schema: u32,
    created_at: String,
}

pub(crate) fn safe_location(root: &Path) -> bool {
    let Ok(root) = crate::host::installation::realpath_or_nearest(root) else {
        return false;
    };
    !butler_platform::user_dirs::is_system_folder(&root)
        && butler_platform::user_dirs::protected_user_folders()
            .iter()
            .all(|folder| {
                crate::host::installation::realpath_or_nearest(folder)
                    .is_ok_and(|folder| !secure_fs::path_is_within(&folder, &root))
            })
}

pub(crate) fn owned(root: &Path) -> bool {
    secure_fs::open_read_beneath(root, Path::new(MARKER))
        .ok()
        .and_then(|f| serde_json::from_reader::<_, Owner>(f).ok())
        .is_some_and(|o| {
            o.schema == 1 && chrono::DateTime::parse_from_rfc3339(&o.created_at).is_ok()
        })
}

// open_lock is the common first writer of DATA/state for service/CLI startup.
// Inspect before it creates even the lock directory, never on a request path.
fn initialize_empty(root: &Path) -> io::Result<()> {
    let empty = match fs::read_dir(root) {
        Ok(mut entries) => entries.next().transpose()?.is_none(),
        Err(e) if e.kind() == io::ErrorKind::NotFound => true,
        Err(e) => return Err(e),
    };
    if empty && safe_location(root) {
        write(root)?;
    }
    Ok(())
}

pub(crate) fn migrate(root: &Path, requested: &Path, default: &Path) -> io::Result<()> {
    if fs::symlink_metadata(root.join(MARKER)).is_ok() || !safe_location(root) {
        return Ok(());
    }
    // Compare resolved default locations, retaining the configured path to
    // refuse a symlink alias. Unknown entries are preserved by reset.
    let is_default = fs::symlink_metadata(requested)
        .is_ok_and(|m| m.is_dir() && !m.file_type().is_symlink())
        && default.canonical().is_ok_and(|path| path == root);
    if is_default {
        return write(root);
    }
    for entry in fs::read_dir(root)? {
        let entry = entry?;
        let kind = entry.file_type()?;
        if kind.is_symlink()
            || !plan::recognized_root(&entry.file_name(), kind).unwrap_or(false)
        {
            return Ok(());
        }
    }
    write(root)
}
fn write(root: &Path) -> io::Result<()> {
    secure_fs::create_private_dir_all(&root.join("state"))?;
    let marker = Owner {
        schema: 1,
        created_at: chrono::Utc::now().to_rfc3339(),
    };
    secure_fs::replace_private(
        &root.join(MARKER),
        |f| serde_json::to_writer(f, &marker).map_err(io::Error::other),
        |e| e,
    )
}

pub(crate) fn initialize_for_lock(parent: &Path) -> Result<(), crate::host::HostError> {
    if let Some(root) = parent.parent() {
        initialize_empty(root).map_err(|source| {
            crate::host::HostError::new("data_root_ownership_unavailable").with_source(source)
        })?;
    }
    Ok(())
}
