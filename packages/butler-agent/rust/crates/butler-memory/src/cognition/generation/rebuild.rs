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
pub(in crate::cognition::generation) use readiness::assert_live_inventory_matches_candidate;
pub use readiness::{compute as compute_rebuild_readiness, record as record_rebuild_readiness};
pub use refresh::refresh_if_changed as refresh_memory_rebuild_snapshot;
use rusqlite::{Connection, OpenFlags, OptionalExtension, params};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use tokio_util::sync::CancellationToken;

use super::initialize::durable;
use crate::{
    cognition::{
        CognitionError, CognitionPathEnvironment, CognitionResult, ensure_data_authority,
        graph::GraphRepository,
    },
    coordination::{CognitionWaitClass, CognitionWriteAcquire, CognitionWriteCoordinator},
};

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
    let memory_root = environment.memory_root(&data_root);
    if memory_root != data_root.join("cognition/memory") {
        return Err(error(CognitionCode::MemoryRebuildPathOverrideUnsupported));
    }
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
    let stage_data = data_root.clone();
    let stage_cancel = cancellation.clone();
    let stage_now = now.clone();
    let stage_id = generation_id.clone();
    let staged_clone = staged.clone();
    let snapshot = tokio::task::spawn_blocking(move || {
        stage(
            &stage_data,
            &staged_clone,
            &stage_id,
            &stage_now,
            &stage_cancel,
        )
    })
    .await
    .map_err(|source| error(CognitionCode::MemoryRebuildPrepareFailed).with_source(source))??;
    let mut staged_cleanup = StagedCleanup(Some(staged.clone()));
    if cancellation.is_cancelled() {
        return Err(error(CognitionCode::MemoryOperationAborted));
    }
    let lease = coordinator
        .acquire(
            CognitionWriteAcquire {
                lock_path: lock.clone(),
                purpose: Some("rebuild_prepare".into()),
                deadline_at_epoch_ms: None,
                cancellation: Some(cancellation.clone()),
            },
            CognitionWaitClass::Background,
        )
        .await
        .map_err(gate_error)?
        .ok_or_else(|| error(CognitionCode::MemoryWriteBusy))?;
    let result = (|| {
        lease
            .assert_for_path(&lock)
            .map_err(|source| error(CognitionCode::MemoryWriteBusy).with_source(source))?;
        if cancellation.is_cancelled() {
            return Err(error(CognitionCode::MemoryOperationAborted));
        }
        let current = inventory::read(&data_root, &canonical, &now, &cancellation)?;
        if current.canonical_revision != snapshot.canonical_revision
            || current.hash != snapshot.source_inventory_hash
        {
            return Err(error(CognitionCode::MemorySourceChanged));
        }
        if published.exists() {
            return Err(error(CognitionCode::MemoryGenerationChanged));
        }
        ensure_data_authority(&data_root, &[&staged, &published, &lock])?;
        let snapshot_id = snapshot_id(&generation_id, &snapshot.source_inventory_hash)?;
        let manifest = json!({
            "schema":"butler.memory-generation.v2", "generation_id":generation_id,
            "format":"v2", "state":"building", "initialization_origin":"rebuild",
            "schema_version":3, "extraction_version":"memory-extract-v3",
            "ranking_version":2, "embedding":null, "unicode_version":unicode_version,
            "icu_version":icu_version, "canonical_snapshot_id":snapshot_id,
            "canonical_snapshot_path":"source-snapshot/runtime/conversation-store.sqlite",
            "canonical_snapshot": {
                "file_sha256":snapshot.canonical_sha256, "bytes":snapshot.canonical_bytes,
                "duration_ms":snapshot.duration_ms, "canonical_revision":snapshot.canonical_revision,
                "base_snapshot_id":null, "delta_from_snapshot_id":null,
            },
            "source_inventory_hash":snapshot.source_inventory_hash,
            "registered_source_count":0, "unaccounted_source_count":snapshot.source_count,
            "required_acceptance_passed":false,
        });
        durable::write_json(&staged.join("manifest.json"), &manifest)?;
        fs::rename(&staged, &published).map_err(io_error)?;
        staged_cleanup.0.take();
        File::open(&generations)
            .and_then(|directory| directory.sync_all())
            .map_err(io_error)?;
        Ok(PreparedRebuild {
            generation_id,
            canonical_snapshot_id: snapshot_id,
            source_inventory_hash: snapshot.source_inventory_hash,
            unaccounted_source_count: snapshot.source_count,
        })
    })();
    let released = lease
        .release(result.is_ok())
        .map_err(|source| error(CognitionCode::MemoryWriteBusy).with_source(source));
    match (result, released) {
        (Err(error), _) | (Ok(_), Err(error)) => Err(error),
        (Ok(value), Ok(())) => Ok(value),
    }
}

struct Staged {
    source_inventory_hash: String,
    source_count: usize,
    canonical_revision: i64,
    canonical_sha256: String,
    canonical_bytes: u64,
    duration_ms: u64,
}

fn stage(
    data_root: &Path,
    staged: &Path,
    generation_id: &str,
    as_of: &str,
    cancellation: &CancellationToken,
) -> CognitionResult<Staged> {
    let result = (|| {
        if staged.exists() {
            return Err(error(CognitionCode::MemoryGenerationChanged));
        }
        let live_path = data_root.join("runtime/conversation-store.sqlite");
        let live = inventory::read(data_root, &live_path, as_of, cancellation)?;
        let snapshot_root = staged.join("source-snapshot");
        let snapshot_path = snapshot_root.join("runtime/conversation-store.sqlite");
        durable::create_dir(
            snapshot_path
                .parent()
                .ok_or_else(|| error(CognitionCode::MemorySnapshotChanged))?,
        )?;
        let start = SystemTime::now();
        let db = Connection::open_with_flags(&live_path, OpenFlags::SQLITE_OPEN_READ_ONLY)
            .map_err(|source| error(CognitionCode::MemorySnapshotChanged).with_source(source))?;
        let path = snapshot_path
            .to_str()
            .ok_or_else(|| error(CognitionCode::MemorySnapshotChanged))?;
        db.execute("VACUUM INTO ?1", params![path])
            .map_err(|source| error(CognitionCode::MemorySnapshotChanged).with_source(source))?;
        db.close().map_err(|(_, source)| {
            error(CognitionCode::MemorySnapshotChanged).with_source(source)
        })?;
        File::open(&snapshot_path)
            .and_then(|file| file.sync_all())
            .map_err(io_error)?;
        if let Some(directory) = snapshot_path.parent() {
            File::open(directory)
                .and_then(|dir| dir.sync_all())
                .map_err(io_error)?;
        }
        if cancellation.is_cancelled() {
            return Err(error(CognitionCode::MemoryOperationAborted));
        }
        typed_snapshot::copy_typed_sources(data_root, &snapshot_root)?;
        if cancellation.is_cancelled() {
            return Err(error(CognitionCode::MemoryOperationAborted));
        }
        let snapshot = inventory::read(&snapshot_root, &snapshot_path, as_of, cancellation)?;
        if snapshot.hash != live.hash
            || snapshot.value != live.value
            || snapshot.canonical_revision != live.canonical_revision
        {
            return Err(error(CognitionCode::MemorySnapshotChanged));
        }
        durable::write_json(
            &snapshot_root.join("memory-source-inventory.json"),
            &live.value,
        )?;
        GraphRepository::create_fresh(&staged.join("graph.sqlite"), as_of)?;
        File::open(staged.join("graph.sqlite"))
            .and_then(|file| file.sync_all())
            .map_err(io_error)?;
        File::open(staged)
            .and_then(|dir| dir.sync_all())
            .map_err(io_error)?;
        let canonical_bytes = fs::metadata(&snapshot_path).map_err(io_error)?.len();
        let canonical_sha256 = hash_file(&snapshot_path)?;
        let duration_ms = u64::try_from(
            start
                .elapsed()
                .unwrap_or_default()
                .as_millis()
                .min(u128::from(u64::MAX)),
        )
        .unwrap_or(u64::MAX);
        let _ = generation_id;
        Ok(Staged {
            source_inventory_hash: live.hash,
            source_count: live.source_count,
            canonical_revision: live.canonical_revision,
            canonical_sha256,
            canonical_bytes,
            duration_ms,
        })
    })();
    if result.is_err() {
        let _ = fs::remove_dir_all(staged);
    }
    result
}

pub fn inspect(
    data_root: &Path,
    environment: &CognitionPathEnvironment,
    generation_id: &str,
) -> CognitionResult<Value> {
    if generation_id.len() != 36
        || !generation_id
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte) || byte == b'-')
    {
        return Err(error(CognitionCode::MemoryGenerationVersionUnsupported));
    }
    let root = environment
        .memory_root(data_root)
        .join("generations")
        .join(generation_id);
    let graph = root.join("graph.sqlite");
    let manifest_path = root.join("manifest.json");
    ensure_data_authority(data_root, &[&root, &graph, &manifest_path])?;
    let manifest: Value =
        serde_json::from_slice(&fs::read(manifest_path).map_err(|source| {
            error(CognitionCode::MemoryGenerationUnavailable).with_source(source)
        })?)
        .map_err(|source| error(CognitionCode::MemoryGenerationUnavailable).with_source(source))?;
    if manifest["schema"] != "butler.memory-generation.v2"
        || manifest["generation_id"] != generation_id
    {
        return Err(error(CognitionCode::MemoryGenerationVersionUnsupported));
    }
    if !graph.is_file() {
        return Ok(
            json!({"manifest":manifest,"graph_path":graph,"degraded":true,
            "reason":"graph_unavailable","jobs":null,"windows":null,"vectors":null,"cache":null}),
        );
    }
    let db = Connection::open_with_flags(&graph, OpenFlags::SQLITE_OPEN_READ_ONLY)
        .map_err(|source| error(CognitionCode::MemoryGenerationUnavailable).with_source(source))?;
    let count = |sql: &str| -> CognitionResult<i64> {
        db.query_row(sql, [], |row| row.get(0))
            .map_err(|source| error(CognitionCode::MemoryGenerationUnavailable).with_source(source))
    };
    let stored_cursor: Option<String> = db
        .query_row(
            "SELECT value FROM memory_state WHERE key='rebuild_typed_cursor'",
            [],
            |row| row.get(0),
        )
        .optional()
        .map_err(|source| error(CognitionCode::MemoryGenerationUnavailable).with_source(source))?;
    let typed_cursor = stored_cursor
        .and_then(|value| serde_json::from_str::<Value>(&value).ok())
        .filter(|value| value["snapshot_id"] == manifest["canonical_snapshot_id"])
        .and_then(|value| value["source_key"].as_str().map(str::to_owned));
    Ok(
        json!({"manifest":manifest,"graph_path":graph,"degraded":false,"reason":null,
            "jobs":count("SELECT COUNT(*) FROM memory_projection_jobs")?,
            "registered_sources":count("SELECT COUNT(*) FROM memory_chunk_sources")?,
            "typed_cursor":typed_cursor,
            "windows": {"complete":count("SELECT COUNT(*) FROM memory_projection_windows WHERE state='complete'")?,
                "unsupported":count("SELECT COUNT(*) FROM memory_projection_windows WHERE state='unsupported'")?,
                "pending":count("SELECT COUNT(*) FROM memory_projection_windows WHERE state IN ('pending','planned','running')")?,
                "failed":count("SELECT COUNT(*) FROM memory_projection_windows WHERE state='failed'")?},
            "vectors": {"complete":count("SELECT COUNT(*) FROM memory_vector_units WHERE state='complete'")?,
                "pending":count("SELECT COUNT(*) FROM memory_vector_units WHERE state IN ('pending','running')")?,
                "failed":count("SELECT COUNT(*) FROM memory_vector_units WHERE state='failed'")?},
            "cache": {"complete":count("SELECT COUNT(*) FROM memory_projection_jobs WHERE json_extract(hot_cache_state,'$.state')='complete'")?,
                "pending":count("SELECT COUNT(*) FROM memory_projection_jobs WHERE json_extract(hot_cache_state,'$.state') IN ('pending','running','partial')")?,
                "failed":count("SELECT COUNT(*) FROM memory_projection_jobs WHERE json_extract(hot_cache_state,'$.state')='failed'")?,
                "not_configured":count("SELECT COUNT(*) FROM memory_projection_jobs WHERE json_extract(hot_cache_state,'$.state')='not_configured'")?},
        }),
    )
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
        hash.update(&buffer[..n]);
    }
    Ok(format!("{:x}", hash.finalize()))
}
fn io_error(error: std::io::Error) -> CognitionError {
    CognitionError::new(CognitionCode::MemoryRebuildIoError, error.to_string()).with_source(error)
}
/// A caller cancellation observed while waiting for the write gate is an abort,
/// not contention: `memory_write_busy` is retryable for callers.
#[expect(
    clippy::needless_pass_by_value,
    reason = "map_err/iterator adapter taking owned values"
)]
fn gate_error(failure: crate::coordination::CoordinationError) -> CognitionError {
    if matches!(failure, crate::coordination::CoordinationError::Aborted) {
        error(CognitionCode::MemoryOperationAborted)
    } else {
        error(CognitionCode::MemoryWriteBusy)
    }
}

fn error(code: CognitionCode) -> CognitionError {
    CognitionError::new(code, code.as_str())
}
