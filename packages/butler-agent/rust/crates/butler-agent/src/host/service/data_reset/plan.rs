//! Bounded directory-entry inspection. Large stores are never walked or read.
use super::{
    inventory,
    journal::{GENERATION, JOURNAL},
};
use crate::host::{ResolvedInstallation, service::paths};
use butler_platform::secure_fs::{self, Canonical as _};
use inventory::PARENTS;
use std::{
    fs, io,
    path::{Path, PathBuf},
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
pub(crate) fn movable(path: &Path) -> bool {
    inventory::directory(path).is_some()
}
pub(crate) fn collect(root: &Path, kept_logs: &[PathBuf]) -> io::Result<Vec<PathBuf>> {
    validate_parents(root, kept_logs)?;
    let mut moves = Vec::new();
    for (path, directory) in inventory::entries() {
        let full = root.join(&path);
        // Never traverse a retained parent that is absent or has the wrong type.
        if !real_parents(root, &path)? {
            continue;
        }
        match fs::symlink_metadata(&full) {
            Ok(m) if inventory::matches(&path, directory, m.file_type()) => {
                check_device(root, &full)?;
                moves.push(path);
            }
            Err(e) if e.kind() != io::ErrorKind::NotFound => return Err(e),
            _ => {}
        }
    }
    let logs = Path::new(butler_platform::data_paths::LOGS);
    if real_parents(root, &logs.join("entry"))? {
        for entry in fs::read_dir(root.join(logs))? {
            let entry = entry?;
            let name = entry.file_name();
            if butler_platform::data_paths::OWNED_LOG_STORES
                .iter()
                .any(|source| name == *source)
            {
                continue;
            }
            let path = logs.join(name);
            if super::logs::valid(&path)
                && !kept_logs.contains(&path)
                && inventory::matches(&path, false, entry.file_type()?)
            {
                check_device(root, &entry.path())?;
                moves.push(path);
            }
        }
    }
    moves.sort();
    Ok(moves)
}
fn validate_parents(root: &Path, kept_logs: &[PathBuf]) -> io::Result<()> {
    for path in kept_logs {
        if !real_parents(root, path)? {
            continue;
        }
        match fs::symlink_metadata(root.join(path)) {
            Ok(m) if !m.is_file() || m.file_type().is_symlink() => {
                return Err(io::Error::other("Retention log is not a regular file"));
            }
            Err(e) if e.kind() != io::ErrorKind::NotFound => return Err(e),
            _ => {}
        }
    }
    Ok(())
}
pub(super) fn real_parents(root: &Path, path: &Path) -> io::Result<bool> {
    let mut parent = PathBuf::new();
    let Some(parts) = path.parent() else {
        return Ok(false);
    };
    for part in parts.components() {
        parent.push(part);
        match fs::symlink_metadata(root.join(&parent)) {
            Ok(m) if m.is_dir() && !m.file_type().is_symlink() => {}
            Ok(_) => {
                butler_core::diagnostic!(
                    "[full-reset] retained non-directory parent: {}",
                    parent.display()
                );
                return Ok(false);
            }
            Err(e) if e.kind() == io::ErrorKind::NotFound => return Ok(false),
            Err(e) => return Err(e),
        }
    }
    Ok(true)
}
fn check_device(root: &Path, path: &Path) -> io::Result<()> {
    if !secure_fs::same_device(root, path)? {
        return Err(io::Error::new(
            io::ErrorKind::CrossesDevices,
            "Reset crosses devices",
        ));
    }
    Ok(())
}
pub(crate) fn preflight(
    root: &Path,
    requested: &Path,
    db: &Path,
    installation: &ResolvedInstallation,
    kept_logs: &[PathBuf],
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
    collect(root, kept_logs).map_err(|e| {
        if e.kind() == io::ErrorKind::CrossesDevices {
            "full_reset_cross_device"
        } else {
            invalid
        }
    })
}

// Existing custom installations migrate only when every top-level entry is known.
pub(crate) fn recognized_root(name: &std::ffi::OsStr, kind: fs::FileType) -> Option<bool> {
    if KEPT.iter().chain(PARENTS).any(|p| {
        Path::new(p)
            .components()
            .next()
            .is_some_and(|c| c.as_os_str() == name)
    }) {
        return Some(kind.is_dir());
    }
    for (path, directory) in inventory::entries() {
        let mut parts = path.components();
        if parts.next().is_some_and(|c| c.as_os_str() == name) {
            return Some(if parts.next().is_some() || directory {
                kind.is_dir()
            } else {
                kind.is_file()
            });
        }
    }
    None
}
