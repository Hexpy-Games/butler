use std::{fs, io, path::Path};

use butler_backup::backup::{LocalState, apply_files, read_receipt, walk, write_json};
use butler_platform::{data_paths, secure_fs, sqlite};
use rusqlite::OpenFlags;
use serde::{Deserialize, Serialize};

use super::{graph_path, key_store, now};

#[derive(Deserialize, Serialize)]
struct Applying {
    created_at: String,
    paths: Vec<String>,
    key_system: bool,
    vault_unlock: Option<String>,
}

#[derive(Deserialize, Serialize)]
pub(super) struct Restored {
    pub restored_at: String,
}

pub(crate) async fn apply_staged(root: &Path) -> io::Result<bool> {
    let root = root.to_path_buf();
    tokio::task::spawn_blocking(move || apply(&root))
        .await
        .map_err(io::Error::other)?
}

fn apply(root: &Path) -> io::Result<bool> {
    let staging_root = root.join(data_paths::RESTORE_STAGING);
    let backup = root.join(data_paths::BACKUP);
    let marker = backup.join("applying.json");
    let applying: Applying = match fs::read(&marker) {
        Ok(bytes) => serde_json::from_slice(&bytes)?,
        Err(failure) if failure.kind() == io::ErrorKind::NotFound => {
            let Some(receipt) = read_receipt(&staging_root)?
                .filter(|receipt| receipt.format == 1 && receipt.verified)
            else {
                return Ok(false);
            };
            if super::restore::target_has_data(root).map_err(io::Error::other)? {
                butler_core::diagnostic!(
                    "[backup] restore target has data; leaving staging in place"
                );
                return Ok(false);
            }
            let paths = walk(&staging_root.join("files"))?
                .into_iter()
                .map(|path| {
                    path.into_os_string()
                        .into_string()
                        .map_err(|_| io::Error::other("invalid restore path"))
                })
                .collect::<io::Result<Vec<_>>>()?;
            let vault_unlock = if paths.iter().any(|path| path == "auth/vault.age") {
                let (_, unlock) = super::super::runtime::vault_switch::product_slot(root)
                    .map_err(io::Error::other)?
                    .ok_or_else(|| io::Error::other("vault device key store unavailable"))?;
                Some(unlock.to_owned())
            } else {
                None
            };
            let applying = Applying {
                created_at: receipt.created_at,
                paths,
                key_system: key_store::uses_system(root),
                vault_unlock,
            };
            write_json(&marker, &applying)?;
            applying
        }
        Err(failure) => return Err(failure),
    };
    let mut key = key_store::load_from(root, applying.key_system).map_err(io::Error::other)?;
    if key.is_none() && applying.key_system != key_store::uses_system(root) {
        key = key_store::load(root).map_err(io::Error::other)?;
    }
    let key = key.ok_or_else(|| io::Error::other("restore recovery key is missing"))?;
    apply_files(root, &staging_root, &applying.paths)?;
    complete(root, &applying, &key)?;
    secure_fs::remove_tree(&staging_root)?;
    fs::remove_file(&marker)?;
    Ok(true)
}

fn complete(
    root: &Path,
    applying: &Applying,
    key: &butler_backup::backup::BackupKey,
) -> io::Result<()> {
    if let Some(unlock) = &applying.vault_unlock {
        super::super::runtime::vault_switch::restore_vault(
            root,
            &root.join("auth/vault.age"),
            &key.subkeys().vault_secret,
            unlock,
        )
        .map_err(io::Error::other)?;
    }
    let restored_at = now();
    if applying.paths.iter().any(|path| path == data_paths::APP_DB) {
        let db = sqlite::open_with_flags(
            root.join(data_paths::APP_DB),
            OpenFlags::SQLITE_OPEN_READ_WRITE,
        )
        .map_err(io::Error::other)?;
        let has_noise_static: bool = db
            .query_row(
                "SELECT EXISTS(SELECT 1 FROM pragma_table_info('paired_devices') WHERE name = 'noise_static')",
                [],
                |row| row.get(0),
            )
            .map_err(io::Error::other)?;
        let revoke = if has_noise_static {
            "UPDATE paired_devices SET revoked_at = ?1, noise_static = NULL WHERE revoked_at IS NULL"
        } else {
            "UPDATE paired_devices SET revoked_at = ?1 WHERE revoked_at IS NULL"
        };
        db.execute(revoke, [chrono::Utc::now().timestamp_millis()])
            .map_err(io::Error::other)?;
    }
    if let Some(path) = graph_path(root)?
        && path.try_exists()?
    {
        secure_fs::remove_tree(&path.with_file_name("butler.lance"))?;
        butler_memory::cognition::requeue_vectors(&path).map_err(io::Error::other)?;
    }
    key_store::store(root, key).map_err(io::Error::other)?;
    if applying.key_system != key_store::uses_system(root) {
        key_store::delete_from(root, applying.key_system).map_err(io::Error::other)?;
    }
    write_json(
        &root.join(data_paths::BACKUP).join("restored.json"),
        &Restored { restored_at },
    )?;
    LocalState {
        enabled: true,
        last_success_at: Some(applying.created_at.clone()),
        ..LocalState::default()
    }
    .save(root)
}
