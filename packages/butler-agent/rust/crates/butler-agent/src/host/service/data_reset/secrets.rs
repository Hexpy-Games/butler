//! Snapshot only indexed identifiers and registered folder paths, never secrets.
use super::journal::SecretId;
use butler_platform::{
    secure_fs::{self, Canonical as _},
    sqlite,
};
use rusqlite::OpenFlags;
use std::{
    io,
    path::{Path, PathBuf},
};

pub(crate) fn snapshot(root: &Path, db: &Path) -> io::Result<(Vec<SecretId>, Vec<PathBuf>)> {
    let mut keys = butler_models::models::reset_secret_keys(root)?
        .into_iter()
        .map(|(service, account)| SecretId { service, account })
        .collect::<Vec<_>>();
    // The vault key is cleaned up only where a vault was created.
    let vault = butler_vault::vault::VaultPaths::in_data_root(root);
    if vault.file().is_file()
        && let Ok(key) = butler_vault::vault::keychain_key(root)
    {
        keys.push(SecretId {
            service: key.service().to_owned(),
            account: key.account().to_owned(),
        });
    }
    let db =
        sqlite::open_with_flags(db, OpenFlags::SQLITE_OPEN_READ_ONLY).map_err(io::Error::other)?;
    for (service, account) in butler_gateway::gateway::reset_browser_secret_keys(root, &db)? {
        keys.push(SecretId { service, account });
    }
    let mut statement = db
        .prepare("SELECT workspace_path FROM projects WHERE workspace_path<>''")
        .map_err(io::Error::other)?;
    let folders = statement
        .query_map([], |row| row.get::<_, String>(0))
        .map_err(io::Error::other)?;
    let mut hot_caches = Vec::new();
    for folder in folders {
        let folder = PathBuf::from(folder.map_err(io::Error::other)?);
        if let Ok(real) = folder.canonical() {
            let cache = real.join(".butler/hot-cache.md");
            if secure_fs::open_read_beneath(&real, Path::new(".butler/hot-cache.md")).is_ok() {
                hot_caches.push(cache);
            }
        }
    }
    Ok((keys, hot_caches))
}
