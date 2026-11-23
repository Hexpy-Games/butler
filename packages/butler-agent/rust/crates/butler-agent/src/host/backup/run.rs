use std::{
    collections::{BTreeMap, HashSet},
    fs, io,
    path::{Path, PathBuf},
    sync::{Arc, Mutex, PoisonError},
    time::UNIX_EPOCH,
};

use butler_backup::backup::{
    CachedFile, FileEntry, Kind, LocalState, Manifest, Slot, Subkeys, Usage, chunk_id, is_sqlite,
    open_manifest, pieces, seal_chunk, seal_manifest, unreferenced, validate_manifest, walk,
};
use rusqlite::{Connection, OpenFlags};

use super::{
    Error, Inner, Phase, Result, backup_error, cloud, error, key_store, now, require_plan,
};

struct Source {
    relative: String,
    path: PathBuf,
    kind: Kind,
    size: u64,
    signature: CachedFile,
}

impl Inner {
    pub(super) async fn back_up(&self) -> Result<()> {
        let mut state = self.local_state().await?;
        let result = self.publish(&mut state).await;
        state.last_error = result.as_ref().err().map(super::error_code);
        self.save_state(state).await?;
        result
    }

    async fn publish(&self, state: &mut LocalState) -> Result<()> {
        let cloud = self.cloud.session().await?;
        let inventory = cloud.inventory().await?;
        state.usage = Usage {
            used_bytes: inventory.used_bytes,
            quota_bytes: inventory.quota_bytes,
        };
        require_plan(&inventory)?;
        let (keys, sources) = self
            .blocking(|root| {
                let key = key_store::load(&root)?.ok_or_else(|| {
                    error(409, "backup_key_required", "Create a recovery key first.")
                })?;
                super::update_vault(&root, None, Some(&key))?;
                let sources = walk(&root)
                    .map_err(Error::internal_from)?
                    .into_iter()
                    .map(|rel| source(&root, &rel))
                    .collect::<io::Result<Vec<_>>>()
                    .map_err(Error::internal_from)?;
                Ok((Arc::new(key.subkeys()), sources))
            })
            .await?;
        reconcile_slots(state, &cloud, &inventory.snapshots, &keys).await?;
        let (files, mut manifest) = self.make_manifest(state, &cloud, &keys, sources).await?;
        manifest.created_at = now();
        let slot = state.next_slot;
        let prior = state
            .slots
            .iter()
            .position(|previous| previous.slot == slot);
        let expected = prior.map_or(0, |index| state.slots[index].version);
        let bytes = serde_json::to_vec(&manifest).map_err(Error::internal_from)?;
        let version = cloud
            .push_snapshot(slot, expected, seal_manifest(&keys, &bytes))
            .await?;
        let mut slots = state.slots.clone();
        let old = prior.map(|index| slots.remove(index));
        slots.push(Slot {
            slot,
            version,
            created_at: manifest.created_at.clone(),
            chunks: ids(&manifest),
        });
        if let Some(old) = old {
            cloud
                .delete_chunks(&unreferenced(&old.chunks, &slots))
                .await?;
        }
        let usage = cloud.inventory().await?;
        self.remember_cloud(&usage);
        if let Some(snapshot) = usage
            .snapshots
            .iter()
            .find(|snapshot| snapshot.slot == slot && snapshot.version == version)
            && let Some(published) = slots.last_mut()
        {
            published.created_at.clone_from(&snapshot.created_at);
        }
        state.slots = slots;
        state.files = files;
        state.next_slot = (slot + 1) % 3;
        state.last_success_at = Some(manifest.created_at);
        state.usage = Usage {
            used_bytes: usage.used_bytes,
            quota_bytes: usage.quota_bytes,
        };
        Ok(())
    }

    async fn make_manifest(
        &self,
        state: &LocalState,
        cloud: &cloud::Session,
        keys: &Arc<Subkeys>,
        sources: Vec<Source>,
    ) -> Result<(BTreeMap<String, CachedFile>, Manifest)> {
        let mut manifest = Manifest {
            format: 1,
            created_at: String::new(),
            app_version: super::super::service::diagnostics::version(&self.installation),
            total_bytes: 0,
            files: Vec::with_capacity(sources.len()),
        };
        let cached = |source: &Source| {
            state
                .files
                .get(&source.relative)
                .filter(|cached| same_signature(cached, &source.signature))
                .map(|cached| cached.chunks.clone())
        };
        let changed: Vec<_> = sources
            .iter()
            .filter(|source| cached(source).is_none())
            .map(|source| (source.path.clone(), source.kind))
            .collect();
        let known = Arc::new(chunk_ids(changed, keys.clone()).await?);
        let ids: Vec<_> = known.iter().cloned().collect();
        let uploads = Arc::new(Mutex::new(Uploads {
            known,
            missing: cloud.missing(&ids).await?,
        }));
        let mut files = BTreeMap::new();
        let mut done = 0;
        let mut total: u64 = sources.iter().map(|source| source.size).sum();
        for mut source in sources {
            let (size, chunks) = if let Some(chunks) = cached(&source) {
                (source.size, chunks)
            } else {
                let read = (source.path.clone(), source.kind);
                self.upload(read, cloud, keys.clone(), uploads.clone(), (done, total))
                    .await?
            };
            total = total - source.size + size;
            done += size;
            self.set_phase(Phase::Running { done, total });
            source.signature.chunks.clone_from(&chunks);
            manifest.files.push(FileEntry {
                path: source.relative.clone(),
                size,
                kind: source.kind,
                chunks,
            });
            files.insert(source.relative, source.signature);
        }
        manifest.total_bytes = done;
        validate_manifest(&manifest).map_err(backup_error)?;
        Ok((files, manifest))
    }

    /// Streams one file again and uploads the pieces the server lacks. A piece
    /// that was not hashed before (the file changed since) is uploaded too;
    /// the server ignores a chunk it already holds.
    async fn upload(
        &self,
        (path, kind): (PathBuf, Kind),
        cloud: &cloud::Session,
        keys: Arc<Subkeys>,
        uploads: Arc<Mutex<Uploads>>,
        (done, total): (u64, u64),
    ) -> Result<(u64, Vec<String>)> {
        let runtime = tokio::runtime::Handle::current();
        let cloud = cloud.clone();
        let mut size = 0;
        let mut chunks = Vec::new();
        let phase = self.phase.clone();
        tokio::task::spawn_blocking(move || {
            pieces(&path, kind, |plain| {
                let id = chunk_id(&keys, plain);
                if uploads
                    .lock()
                    .unwrap_or_else(PoisonError::into_inner)
                    .needs_upload(&id)
                {
                    runtime
                        .block_on(cloud.push_chunk(&id, seal_chunk(&keys, &id, plain)))
                        .map_err(io::Error::other)?;
                }
                size += plain.len() as u64;
                chunks.push(id);
                *phase.lock().unwrap_or_else(PoisonError::into_inner) = Phase::Running {
                    done: done + size,
                    total: total.max(done + size),
                };
                Ok::<_, io::Error>(())
            })
            .map_err(cloud_failure)?;
            Ok((size, chunks))
        })
        .await
        .map_err(Error::internal_from)?
    }
}

struct Uploads {
    known: Arc<HashSet<String>>,
    missing: HashSet<String>,
}

impl Uploads {
    fn needs_upload(&mut self, id: &str) -> bool {
        self.missing.remove(id) || !self.known.contains(id)
    }
}

/// First pass: the chunk ids of the changed files, so `missing` is asked in
/// batches without holding any plaintext.
async fn chunk_ids(files: Vec<(PathBuf, Kind)>, keys: Arc<Subkeys>) -> Result<HashSet<String>> {
    tokio::task::spawn_blocking(move || {
        let mut ids = HashSet::new();
        for (path, kind) in files {
            pieces(&path, kind, |plain| {
                ids.insert(chunk_id(&keys, plain));
                Ok::<_, io::Error>(())
            })?;
        }
        Ok::<_, io::Error>(ids)
    })
    .await
    .map_err(Error::internal_from)?
    .map_err(Error::internal_from)
}

fn cloud_failure(failure: io::Error) -> Error {
    match failure
        .get_ref()
        .and_then(|error| error.downcast_ref::<Error>())
    {
        Some(cloud) => cloud.clone(),
        None => Error::internal_from(failure),
    }
}

async fn reconcile_slots(
    state: &mut LocalState,
    cloud: &cloud::Session,
    snapshots: &[cloud::Snapshot],
    keys: &Subkeys,
) -> Result<()> {
    let mut live = Vec::with_capacity(snapshots.len());
    for snapshot in snapshots {
        if let Some(cached) = state.slots.iter().find(|slot| {
            slot.slot == snapshot.slot
                && slot.version == snapshot.version
                && slot.created_at == snapshot.created_at
        }) {
            live.push(cached.clone());
            continue;
        }
        let bytes =
            open_manifest(keys, cloud.pull_snapshot(snapshot).await?).map_err(backup_error)?;
        let manifest: Manifest = serde_json::from_slice(&bytes)
            .map_err(|_| backup_error(butler_backup::backup::BackupError::ManifestInvalid))?;
        validate_manifest(&manifest).map_err(backup_error)?;
        live.push(Slot {
            slot: snapshot.slot,
            version: snapshot.version,
            created_at: snapshot.created_at.clone(),
            chunks: ids(&manifest),
        });
    }
    if live.len() != state.slots.len() || live.iter().any(|slot| !state.slots.contains(slot)) {
        for old in &state.slots {
            if !live.contains(old) {
                cloud
                    .delete_chunks(&unreferenced(&old.chunks, &live))
                    .await?;
            }
        }
        state.files.clear();
        state.next_slot = (0..3)
            .find(|slot| !live.iter().any(|snapshot| snapshot.slot == *slot))
            .or_else(|| {
                live.iter()
                    .min_by_key(|snapshot| &snapshot.created_at)
                    .map(|snapshot| snapshot.slot)
            })
            .unwrap_or_default();
        state.slots = live;
    }
    Ok(())
}

fn ids(manifest: &Manifest) -> Vec<String> {
    let mut seen = HashSet::new();
    manifest
        .files
        .iter()
        .flat_map(|file| &file.chunks)
        .filter(|id| seen.insert(*id))
        .cloned()
        .collect()
}

fn source(root: &Path, relative: &Path) -> io::Result<Source> {
    let path = root.join(relative);
    let relative = relative
        .to_str()
        .ok_or_else(|| io::Error::other("invalid backup path"))?
        .to_owned();
    let (size, mtime_ms) = stamp(&path)?;
    let (kind, logical_size, wal_size, wal_mtime_ms) = if is_sqlite(&path)? {
        let (wal_size, wal_mtime_ms) = match stamp(&root.join(format!("{relative}-wal"))) {
            Ok(stamp) => stamp,
            Err(error) if error.kind() == io::ErrorKind::NotFound => (0, 0),
            Err(error) => return Err(error),
        };
        let db = Connection::open_with_flags(
            &path,
            OpenFlags::SQLITE_OPEN_READ_ONLY
                | OpenFlags::SQLITE_OPEN_NO_MUTEX
                | OpenFlags::SQLITE_OPEN_NOFOLLOW,
        )
        .map_err(io::Error::other)?;
        let logical_size = db
            .query_row(
                "SELECT page_count * page_size FROM pragma_page_count(), pragma_page_size()",
                [],
                |row| row.get(0),
            )
            .map_err(io::Error::other)?;
        (Kind::Sqlite, logical_size, wal_size, wal_mtime_ms)
    } else {
        (Kind::File, size, 0, 0)
    };
    Ok(Source {
        relative,
        path,
        kind,
        size: logical_size,
        signature: CachedFile {
            size,
            mtime_ms,
            wal_size,
            wal_mtime_ms,
            chunks: Vec::new(),
        },
    })
}

fn stamp(path: &Path) -> io::Result<(u64, u64)> {
    let meta = fs::metadata(path)?;
    let mtime = meta
        .modified()?
        .duration_since(UNIX_EPOCH)
        .map_or(0, |duration| {
            u64::try_from(duration.as_millis()).unwrap_or(u64::MAX)
        });
    Ok((meta.len(), mtime))
}

fn same_signature(file: &CachedFile, other: &CachedFile) -> bool {
    (file.size, file.mtime_ms, file.wal_size, file.wal_mtime_ms)
        == (
            other.size,
            other.mtime_ms,
            other.wal_size,
            other.wal_mtime_ms,
        )
}
