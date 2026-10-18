//! Bounded directory-entry inspection. Large stores are never walked or read.
use super::journal::{GENERATION, JOURNAL, TRASH_PREFIX};
use crate::host::{ResolvedInstallation, service::paths};
use butler_platform::secure_fs::{self, Canonical as _};
use std::{
    fs, io,
    path::{Component, Path, PathBuf},
};

const KEPT: &[&str] = &[
    "project-ledger",
    "bin",
    "updates",
    "cache/models",
    "cache/browser",
    "locks",
    "app/runtime/foreground",
    "app/runtime/embed",
    "app/runtime/menu-bar-helper.pid",
    "app/runtime/menu-bar-helper-profile",
    paths::INSTANCE_LOCK,
    paths::ADMISSION_LOCK,
    paths::INSTANCE_RECORD,
    paths::RECORD_LOCK,
    paths::STOP_INTENT,
    paths::CLI_SUPERVISOR_LOCK,
    JOURNAL,
    GENERATION,
    super::super::data_ownership::MARKER,
];
const PARENTS: &[&str] = &["state", "cache", "app", "app/runtime", "logs"];
pub(crate) fn movable(path: &Path) -> bool {
    path.components().all(|c| matches!(c, Component::Normal(_)))
        && !path.as_os_str().is_empty()
        && !kept(path)
        && path
            .parent()
            .is_some_and(|p| p.as_os_str().is_empty() || PARENTS.iter().any(|v| p == Path::new(v)))
        && !PARENTS.iter().any(|p| path == Path::new(p))
}
fn kept(path: &Path) -> bool {
    super::logs::kept(path)
        || KEPT.iter().any(|p| path == Path::new(p))
        || path.components().count() == 1 && path.to_string_lossy().starts_with(TRASH_PREFIX)
}
pub(crate) fn collect(root: &Path) -> io::Result<Vec<PathBuf>> {
    let logs = super::logs::paths();
    let paths = PARENTS
        .iter()
        .chain(KEPT.iter())
        .map(Path::new)
        .chain(logs.iter().map(PathBuf::as_path));
    for name in paths {
        let path = root.join(name);
        match fs::symlink_metadata(&path) {
            Ok(m) if m.file_type().is_symlink() => {
                return Err(io::Error::other("Retention path is a link"));
            }
            Ok(m) if PARENTS.iter().any(|p| name == Path::new(p)) && !m.is_dir() => {
                return Err(io::Error::other("Retention parent is not a directory"));
            }
            Ok(m) if logs.iter().any(|p| p.as_path() == name) && !m.is_file() => {
                return Err(io::Error::other("Retention log is not a regular file"));
            }
            Err(e) if e.kind() != io::ErrorKind::NotFound => return Err(e),
            _ => {}
        }
    }
    let mut moves = Vec::new();
    children(root, Path::new(""), &mut moves)?;
    moves.sort();
    Ok(moves)
}
fn children(root: &Path, relative: &Path, moves: &mut Vec<PathBuf>) -> io::Result<()> {
    for entry in fs::read_dir(root.join(relative))? {
        let entry = entry?;
        let child = relative.join(entry.file_name());
        if kept(&child) {
            continue;
        }
        if !secure_fs::same_device(root, &entry.path())? {
            return Err(io::Error::new(
                io::ErrorKind::CrossesDevices,
                "Reset crosses devices",
            ));
        }
        if PARENTS.iter().any(|p| child == Path::new(p)) {
            children(root, &child, moves)?;
        } else {
            moves.push(child);
        }
    }
    Ok(())
}
pub(crate) fn preflight(
    root: &Path,
    requested: &Path,
    db: &Path,
    installation: &ResolvedInstallation,
) -> Result<Vec<PathBuf>, &'static str> {
    if !super::super::data_ownership::safe_location(root)
        || !super::super::data_ownership::owned(root)
    {
        return Err("full_reset_unsafe_root");
    }
    let invalid = "full_reset_external_store";
    installation.validate_data_root(root).map_err(|_| invalid)?;
    let home = butler_runtime::operations::AgentHome::resolve().map_err(|_| invalid)?;
    super::super::purge_policy::allowed(root, requested, home.root()).map_err(|_| invalid)?;
    let canonical = root.canonical().map_err(|_| invalid)?;
    let mut stores = vec![db.to_path_buf()];
    for variable in [
        "BUTLER_APP_SERVER_DB",
        "BUTLER_COGNITION_HOME",
        "BUTLER_COGNITION_MEMORY_HOME",
        "BUTLER_APP_LOCAL_AUTH_FILE",
    ] {
        if let Some(path) = std::env::var_os(variable).filter(|v| !v.is_empty()) {
            stores.push(path.into());
        }
    }
    let config: serde_json::Value = match fs::read(root.join("gateways/app.json")) {
        Ok(bytes) => serde_json::from_slice(&bytes).map_err(|_| invalid)?,
        Err(e) if e.kind() == io::ErrorKind::NotFound => serde_json::Value::Null,
        Err(_) => return Err(invalid),
    };
    if let Some(path) = config
        .pointer("/config/dbPath")
        .and_then(serde_json::Value::as_str)
    {
        stores.push(path.into());
    }
    for path in stores {
        let absolute = if path.is_absolute() {
            path
        } else {
            std::env::current_dir().map_err(|_| invalid)?.join(path)
        };
        let resolved =
            crate::host::installation::realpath_or_nearest(&absolute).map_err(|_| invalid)?;
        if !secure_fs::path_is_within(&resolved, &canonical) {
            return Err(invalid);
        }
    }
    collect(root).map_err(|e| {
        if e.kind() == io::ErrorKind::CrossesDevices {
            "full_reset_cross_device"
        } else {
            invalid
        }
    })
}

// Some(valid type) for names the retention/configuration code itself owns;
// None for unknown entries. Only the default-root migration may accept None.
pub(crate) fn recognized_root(name: &std::ffi::OsStr, kind: fs::FileType) -> Option<bool> {
    let retained = KEPT.iter().chain(PARENTS).copied().any(|path| {
        Path::new(path)
            .components()
            .next()
            .is_some_and(|c| c.as_os_str() == name)
    });
    if retained {
        return Some(kind.is_dir());
    }
    for path in butler_platform::data_paths::OWNED_PATHS {
        let mut parts = Path::new(path).components();
        if parts.next().is_none_or(|c| c.as_os_str() != name) {
            continue;
        }
        let directory =
            parts.next().is_some() || butler_platform::data_paths::OWNED_DIRECTORIES.contains(path);
        return Some(if directory {
            kind.is_dir()
        } else {
            kind.is_file()
        });
    }
    butler_platform::data_paths::LOCKED_FILES
        .iter()
        .any(|path| name == std::ffi::OsStr::new(&format!("{path}.lock")))
        .then_some(kind.is_file())
}
