//! Separate, snapshot-backed rebuild candidate. Preparation never activates it.

mod build_inventory;
mod inventory;
mod legacy_baseline;
pub(super) mod readiness;
mod refresh;
#[cfg(test)]
mod tests;
mod typed_snapshot;

use crate::cognition::CognitionCode;
use butler_platform::sqlite;
use std::{
    fs::{self, File},
    path::{Path, PathBuf},
    sync::Arc,
    time::SystemTime,
};

pub use build_inventory::{
    BuildInventory, assert_registered as assert_rebuild_sources_registered,
    read as read_build_inventory, typed_cursor as rebuild_typed_cursor,
};
pub(in crate::cognition) use inventory::MemorySourceInventory;
pub(in crate::cognition::generation) use readiness::assert_live_inventory_matches_candidate;
pub use readiness::{compute as compute_rebuild_readiness, record as record_rebuild_readiness};
pub use refresh::refresh_if_changed as refresh_memory_rebuild_snapshot;
use rusqlite::{OpenFlags, OptionalExtension, params};
use serde::Serialize;
use serde_json::json;
use sha2::{Digest, Sha256};
use tokio_util::sync::CancellationToken;

use super::initialize::durable;
use super::manifest::{
    CanonicalSnapshot, GenerationFormat, GenerationManifest, GenerationState, InitializationOrigin,
    NewManifest, RuntimeVersions, SemanticCounts, StageCounts,
};
use crate::{
    cognition::{
        CognitionError, CognitionPathEnvironment, CognitionResult, ensure_data_authority,
        graph::GraphRepository,
    },
    coordination::CognitionWriteCoordinator,
};
mod inspect;
pub use inspect::{RebuildInspection, VectorCounts, inspect};

/// Identity of a freshly prepared rebuild candidate.
pub struct PreparedRebuild {
    pub generation_id: String,
    pub canonical_snapshot_id: String,
    pub source_inventory_hash: String,
    pub unaccounted_source_count: usize,
}
struct StagedCleanup(Option<PathBuf>);
impl Drop for StagedCleanup {
    fn drop(&mut self) {
        if let Some(path) = &self.0 {
            let _ = fs::remove_dir_all(path);
        }
    }
}
/// Rebuilds support only the default memory root under DATA.
fn default_memory_root(
    data_root: &Path,
    environment: &CognitionPathEnvironment,
) -> CognitionResult<PathBuf> {
    let memory_root = environment.memory_root(data_root);
    if memory_root != data_root.join("cognition/memory") {
        return Err(error(CognitionCode::MemoryRebuildPathOverrideUnsupported));
    }
    Ok(memory_root)
}

/// Stages a snapshot-backed rebuild candidate and publishes it as `building`.
/// Preparation never activates it.
pub async fn prepare(
    data_root: PathBuf,
    environment: CognitionPathEnvironment,
    coordinator: Arc<CognitionWriteCoordinator>,
    cancellation: CancellationToken,
    now: String,
    unicode_version: String,
    icu_version: String,
) -> CognitionResult<PreparedRebuild> {
    if cancellation.is_cancelled() {
        return Err(error(CognitionCode::MemoryOperationAborted));
    }
    if unicode_version.is_empty() || icu_version.is_empty() {
        return Err(error(CognitionCode::MemoryRuntimeVersionUnavailable));
    }
    let memory_root = default_memory_root(&data_root, &environment)?;
    let generations = memory_root.join("generations");
    let lock = environment.consolidation_lock(&data_root);
    let canonical = data_root.join("runtime/conversation-store.sqlite");
    ensure_data_authority(&data_root, &[&memory_root, &generations, &lock, &canonical])?;
    legacy_baseline::ensure(
        &data_root,
        &memory_root,
        &canonical,
        &lock,
        &coordinator,
        &cancellation,
        &now,
    )
    .await?;
    let generation_id = uuid::Uuid::new_v4().to_string();
    let staged = generations.join(format!(".prepare-{generation_id}"));
    let published = generations.join(&generation_id);
    ensure_data_authority(&data_root, &[&staged, &published])?;
    let (stage_data, stage_path, stage_now, stage_cancel) = (
        data_root.clone(),
        staged.clone(),
        now.clone(),
        cancellation.clone(),
    );
    let snapshot = tokio::task::spawn_blocking(move || {
        stage(&stage_data, &stage_path, &stage_now, &stage_cancel)
    })
    .await
    .map_err(|source| error(CognitionCode::MemoryRebuildPrepareFailed).with_source(source))??;
    let staged_cleanup = StagedCleanup(Some(staged.clone()));
    if cancellation.is_cancelled() {
        return Err(error(CognitionCode::MemoryOperationAborted));
    }
    let lease = crate::cognition::generation::stage::acquire_abortable(
        &coordinator,
        &lock,
        "rebuild_prepare",
        &cancellation,
    )
    .await?;
    let publication = Publication {
        data_root,
        canonical,
        lock,
        generations,
        staged,
        published,
        generation_id,
        now,
        unicode_version,
        icu_version,
        cancellation,
        snapshot,
        staged_cleanup,
    };
    crate::cognition::generation::stage::leased(
        lease,
        CognitionCode::MemoryRebuildPrepareFailed,
        move |lease| publication.publish(lease),
    )
    .await
}

/// A staged candidate waiting to be published under the write lease.
struct Publication {
    data_root: PathBuf,
    canonical: PathBuf,
    lock: PathBuf,
    generations: PathBuf,
    staged: PathBuf,
    published: PathBuf,
    generation_id: String,
    now: String,
    unicode_version: String,
    icu_version: String,
    cancellation: CancellationToken,
    snapshot: Staged,
    staged_cleanup: StagedCleanup,
}

impl Publication {
    /// Rechecks the live sources against the staged snapshot, writes the
    /// `building` manifest, and renames the staged directory into place.
    fn publish(
        mut self,
        lease: &crate::coordination::CognitionWriteLease,
    ) -> CognitionResult<PreparedRebuild> {
        lease
            .assert_for_path(&self.lock)
            .map_err(|source| error(CognitionCode::MemoryWriteBusy).with_source(source))?;
        if self.cancellation.is_cancelled() {
            return Err(error(CognitionCode::MemoryOperationAborted));
        }
        let current = inventory::read(
            &self.data_root,
            &self.canonical,
            &self.now,
            &self.cancellation,
        )?;
        if current.canonical_revision != self.snapshot.canonical_revision
            || current.hash != self.snapshot.source_inventory_hash
        {
            return Err(error(CognitionCode::MemorySourceChanged));
        }
        if self.published.exists() {
            return Err(error(CognitionCode::MemoryGenerationChanged));
        }
        ensure_data_authority(
            &self.data_root,
            &[&self.staged, &self.published, &self.lock],
        )?;
        let snapshot_id = snapshot_id(&self.generation_id, &self.snapshot.source_inventory_hash)?;
        let manifest = self.manifest(&snapshot_id);
        durable::write_json(&self.staged.join("manifest.json"), &manifest)?;
        fs::rename(&self.staged, &self.published).map_err(io_error)?;
        self.staged_cleanup.0.take();
        butler_platform::secure_fs::sync_path(&self.generations).map_err(io_error)?;
        Ok(PreparedRebuild {
            generation_id: self.generation_id,
            canonical_snapshot_id: snapshot_id,
            source_inventory_hash: self.snapshot.source_inventory_hash,
            unaccounted_source_count: self.snapshot.source_count,
        })
    }

    fn manifest(&self, snapshot_id: &str) -> GenerationManifest {
        let snapshot = &self.snapshot;
        let mut manifest = GenerationManifest::new(
            NewManifest {
                generation_id: &self.generation_id,
                format: GenerationFormat::V2,
                state: GenerationState::Building,
                origin: InitializationOrigin::Rebuild,
                canonical_snapshot_id: snapshot_id.to_owned(),
                source_inventory_hash: snapshot.source_inventory_hash.clone(),
                unaccounted_source_count: snapshot.source_count as u64,
            },
            Some(&RuntimeVersions {
                unicode: &self.unicode_version,
                icu: &self.icu_version,
            }),
        );
        manifest.canonical_snapshot_path = Some(CANONICAL_SNAPSHOT_PATH.into());
        manifest.canonical_snapshot = Some(CanonicalSnapshot {
            file_sha256: snapshot.canonical_sha256.clone(),
            bytes: snapshot.canonical_bytes,
            duration_ms: snapshot.duration_ms,
            canonical_revision: snapshot.canonical_revision,
            base_snapshot_id: None,
            delta_from_snapshot_id: None,
        });
        manifest
    }
}

/// Canonical store inside a prepared candidate, relative to its root.
const CANONICAL_SNAPSHOT_PATH: &str = "source-snapshot/runtime/conversation-store.sqlite";

struct Staged {
    source_inventory_hash: String,
    source_count: usize,
    canonical_revision: i64,
    canonical_sha256: String,
    canonical_bytes: u64,
    duration_ms: u64,
}

/// Copies the live sources into `staged/source-snapshot`, proves the copy has
/// the live inventory, and creates the empty candidate graph. Removes
/// `staged` on failure.
fn stage(
    data_root: &Path,
    staged: &Path,
    as_of: &str,
    cancellation: &CancellationToken,
) -> CognitionResult<Staged> {
    let result = stage_snapshot(data_root, staged, as_of, cancellation);
    if result.is_err() {
        let _ = fs::remove_dir_all(staged);
    }
    result
}

fn stage_snapshot(
    data_root: &Path,
    staged: &Path,
    as_of: &str,
    cancellation: &CancellationToken,
) -> CognitionResult<Staged> {
    if staged.exists() {
        return Err(error(CognitionCode::MemoryGenerationChanged));
    }
    let live_path = data_root.join("runtime/conversation-store.sqlite");
    let live = inventory::read(data_root, &live_path, as_of, cancellation)?;
    let snapshot_root = staged.join("source-snapshot");
    let snapshot_path = snapshot_root.join("runtime/conversation-store.sqlite");
    let start = SystemTime::now();
    vacuum_snapshot(&live_path, &snapshot_path)?;
    if cancellation.is_cancelled() {
        return Err(error(CognitionCode::MemoryOperationAborted));
    }
    typed_snapshot::copy_typed_sources(data_root, &snapshot_root)?;
    if cancellation.is_cancelled() {
        return Err(error(CognitionCode::MemoryOperationAborted));
    }
    let snapshot = inventory::read(&snapshot_root, &snapshot_path, as_of, cancellation)?;
    if snapshot.hash != live.hash
        || snapshot.inventory != live.inventory
        || snapshot.canonical_revision != live.canonical_revision
    {
        return Err(error(CognitionCode::MemorySnapshotChanged));
    }
    durable::write_json(
        &snapshot_root.join("memory-source-inventory.json"),
        &live.inventory,
    )?;
    GraphRepository::create_fresh(&staged.join("graph.sqlite"), as_of)?;
    sync(&staged.join("graph.sqlite"))?;
    sync(staged)?;
    Ok(Staged {
        source_inventory_hash: live.hash,
        source_count: live.source_count,
        canonical_revision: live.canonical_revision,
        canonical_sha256: hash_file(&snapshot_path)?,
        canonical_bytes: fs::metadata(&snapshot_path).map_err(io_error)?.len(),
        duration_ms: elapsed_ms(start),
    })
}

/// Writes a consistent copy of the SQLite store at `source` to `target` with
/// `VACUUM INTO`, then syncs the copy and its directory.
fn vacuum_snapshot(source: &Path, target: &Path) -> CognitionResult<()> {
    let parent = target
        .parent()
        .ok_or_else(|| error(CognitionCode::MemorySnapshotChanged))?;
    durable::create_dir(parent)?;
    let snapshot_changed = |source| error(CognitionCode::MemorySnapshotChanged).with_source(source);
    let db = sqlite::open_with_flags(source, OpenFlags::SQLITE_OPEN_READ_ONLY)
        .map_err(snapshot_changed)?;
    let path = target
        .to_str()
        .ok_or_else(|| error(CognitionCode::MemorySnapshotChanged))?;
    db.execute("VACUUM INTO ?1", params![path])
        .map_err(snapshot_changed)?;
    db.close().map_err(|(_, source)| snapshot_changed(source))?;
    sync(target)?;
    sync(parent)
}

fn sync(path: &Path) -> CognitionResult<()> {
    butler_platform::secure_fs::sync_path(path).map_err(io_error)
}

fn elapsed_ms(start: SystemTime) -> u64 {
    u64::try_from(start.elapsed().unwrap_or_default().as_millis()).unwrap_or(u64::MAX)
}

fn snapshot_id(generation_id: &str, inventory_hash: &str) -> CognitionResult<String> {
    let bytes = butler_core::json::stringify(&json!([
        "canonical-snapshot-v1",
        generation_id,
        inventory_hash
    ]))
    .map_err(|source| error(CognitionCode::MemorySnapshotChanged).with_source(source))?;
    Ok(format!("{:x}", Sha256::digest(bytes.as_bytes())))
}
fn hash_file(path: &Path) -> CognitionResult<String> {
    use std::io::Read;
    let mut file = File::open(path).map_err(io_error)?;
    let mut hash = Sha256::new();
    let mut buffer = vec![0u8; 64 * 1024];
    loop {
        let n = file.read(&mut buffer).map_err(io_error)?;
        if n == 0 {
            break;
        }
        hash.update(buffer.get(..n).unwrap_or_default());
    }
    Ok(format!("{:x}", hash.finalize()))
}
fn io_error(error: std::io::Error) -> CognitionError {
    CognitionError::new(CognitionCode::MemoryRebuildIoError, error.to_string()).with_source(error)
}
fn error(code: CognitionCode) -> CognitionError {
    CognitionError::new(code, code.as_str())
}
