use std::{fs, io::Write, path::Path, sync::Arc};

use butler_backup::backup::{
    BackupError, BackupKey, FileEntry, Manifest, PIECE, Receipt, Subkeys, open_chunk,
    open_manifest, parse_recovery, validate_manifest, write_receipt,
};
use butler_platform::{data_paths, fs_space, secure_fs, sqlite};
use rusqlite::OpenFlags;

use super::{
    Error, Inner, Phase, Result, backup_error, cloud, error, graph_path, key_store, require_plan,
};

impl Inner {
    pub(super) async fn restore(
        self: &Arc<Self>,
        cloud: &cloud::Session,
        text: &str,
    ) -> Result<()> {
        let key = parse_recovery(text).map_err(backup_error)?;
        self.blocking(|root| {
            if target_has_data(&root)? {
                return Err(error(
                    409,
                    "restore_target_not_empty",
                    "The restore target already has data.",
                ));
            }
            Ok(())
        })
        .await?;
        let inventory = cloud.inventory().await?;
        require_plan(&inventory)?;
        let snapshot = inventory
            .snapshots
            .iter()
            .max_by_key(|snapshot| &snapshot.created_at)
            .ok_or_else(|| error(404, "not_found", "No backup is available."))?;
        let keys = key.subkeys();
        let bytes =
            open_manifest(&keys, cloud.pull_snapshot(snapshot).await?).map_err(backup_error)?;
        let manifest: Manifest = serde_json::from_slice(&bytes)
            .map_err(|_| backup_error(BackupError::ManifestInvalid))?;
        validate_manifest(&manifest).map_err(backup_error)?;
        let needs_vault = manifest
            .files
            .iter()
            .any(|file| file.path == "auth/vault.age");
        let total = manifest.total_bytes;
        self.blocking(move |root| {
            if needs_vault
                && super::super::runtime::vault_switch::product_slot(&root)
                    .map_err(Error::internal_from)?
                    .is_none()
            {
                return Err(error(
                    409,
                    "restore_needs_keychain",
                    "The vault needs a device key store.",
                ));
            }
            if fs_space::available_bytes(&root).map_err(Error::internal_from)?
                < total.saturating_add(total / 10)
            {
                return Err(error(
                    507,
                    "restore_disk_full",
                    "There is not enough disk space to restore.",
                ));
            }
            Ok(())
        })
        .await?;
        self.set_phase(Phase::Restoring { done: 0, total });
        let inner = self.clone();
        let cloud = cloud.clone();
        tokio::spawn(async move {
            let phase = match inner.download(cloud, key, keys, manifest).await {
                Ok(()) => Phase::RestoreReady,
                Err(failure) => Phase::Failed(super::error_code(&failure)),
            };
            inner.set_phase(phase);
        });
        Ok(())
    }

    async fn download(
        &self,
        cloud: cloud::Session,
        key: BackupKey,
        keys: Subkeys,
        manifest: Manifest,
    ) -> Result<()> {
        let runtime = tokio::runtime::Handle::current();
        let phase = self.phase.clone();
        self.blocking(move |root| {
            let staging = root.join(data_paths::RESTORE_STAGING);
            secure_fs::remove_tree(&staging).map_err(Error::internal_from)?;
            let mut done = 0;
            for entry in &manifest.files {
                write_file(
                    &staging,
                    entry,
                    |index| {
                        let id = &entry.chunks[index];
                        let bytes = runtime.block_on(cloud.pull_chunk(id))?;
                        open_chunk(&keys, id, bytes).map_err(backup_error)
                    },
                    |size| {
                        done += size;
                        *phase
                            .lock()
                            .unwrap_or_else(std::sync::PoisonError::into_inner) =
                            Phase::Restoring {
                                done,
                                total: manifest.total_bytes,
                            };
                    },
                )?;
            }
            let staged = butler_backup::backup::walk(&staging.join("files"))
                .map_err(Error::internal_from)?;
            let mut expected: Vec<_> = manifest
                .files
                .iter()
                .map(|file| std::path::PathBuf::from(&file.path))
                .collect();
            expected.sort();
            if staged != expected {
                return Err(backup_error(BackupError::ManifestInvalid));
            }
            key_store::store(&root, &key)?;
            write_receipt(
                &staging,
                &Receipt {
                    format: 1,
                    created_at: manifest.created_at,
                    total_bytes: manifest.total_bytes,
                    verified: true,
                },
            )
            .map_err(Error::internal_from)
        })
        .await
    }
}

fn write_file(
    staging: &Path,
    entry: &FileEntry,
    mut chunk: impl FnMut(usize) -> Result<Vec<u8>>,
    mut progress: impl FnMut(u64),
) -> Result<()> {
    let path = staging.join("files").join(&entry.path);
    secure_fs::create_private_dir_all(path.parent().ok_or_else(Error::internal)?)
        .map_err(Error::internal_from)?;
    secure_fs::replace_private(
        &path,
        |file| {
            let mut remaining = entry.size;
            for index in 0..entry.chunks.len() {
                let bytes = chunk(index)?;
                let len = bytes.len() as u64;
                if len != remaining.min(PIECE as u64) {
                    return Err(backup_error(BackupError::ChunkCorrupt));
                }
                file.write_all(&bytes).map_err(Error::internal_from)?;
                remaining -= len;
                progress(len);
            }
            Ok(())
        },
        Error::internal_from,
    )
}

pub(super) fn target_has_data(root: &Path) -> Result<bool> {
    if root
        .join("auth/vault.age")
        .try_exists()
        .map_err(Error::internal_from)?
    {
        return Ok(true);
    }
    if has_rows(
        &root.join(data_paths::APP_DB),
        "SELECT EXISTS(SELECT 1 FROM turns)",
    )? {
        return Ok(true);
    }
    if let Some(graph) = graph_path(root).map_err(Error::internal_from)? {
        return has_rows(&graph, "SELECT EXISTS(SELECT 1 FROM memory_chunks)");
    }
    Ok(false)
}

fn has_rows(path: &Path, sql: &str) -> Result<bool> {
    if !fs::exists(path).map_err(Error::internal_from)? {
        return Ok(false);
    }
    sqlite::open_with_flags(path, OpenFlags::SQLITE_OPEN_READ_ONLY)
        .and_then(|db| db.query_row(sql, [], |row| row.get(0)))
        .map_err(Error::internal_from)
}
