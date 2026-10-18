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
];
const PARENTS: &[&str] = &["state", "cache", "app", "app/runtime"];
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
    KEPT.iter().any(|p| path == Path::new(p))
        || path.components().count() == 1 && path.to_string_lossy().starts_with(TRASH_PREFIX)
}
pub(crate) fn collect(root: &Path) -> io::Result<Vec<PathBuf>> {
    for name in PARENTS.iter().chain(KEPT.iter()) {
        let path = root.join(name);
        match fs::symlink_metadata(&path) {
            Ok(m) if m.file_type().is_symlink() => {
                return Err(io::Error::other("Retention path is a link"));
            }
            Ok(m) if PARENTS.contains(name) && !m.is_dir() => {
                return Err(io::Error::other("Retention parent is not a directory"));
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
