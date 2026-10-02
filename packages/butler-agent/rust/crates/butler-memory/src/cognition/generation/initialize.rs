//! Source-compatible cutover of a truly empty native memory root.

pub(super) mod durable;
mod empty;

use crate::cognition::CognitionCode;
use std::{path::PathBuf, sync::Arc};

use sha2::{Digest, Sha256};

use super::manifest::{
    ActiveDescriptor, GenerationFormat, GenerationManifest, GenerationState, InitializationOrigin,
    NewManifest, ProjectionMode, RuntimeVersions,
};
use super::{MemoryGenerationHandle, read::resolve_active_generation};
use crate::{
    cognition::{
        CognitionError, CognitionPathEnvironment, CognitionResult, graph::GraphRepository,
    },
    coordination::{
        CognitionWaitClass, CognitionWriteAcquire, CognitionWriteCoordinator, CognitionWriteLease,
    },
};

/// Strict empty-root cutover; existing descriptors and partial sources require
/// rebuild. Service bootstrap uses `prepare_fresh_memory_generation`.
pub async fn initialize_empty_memory_generation(
    data_root: PathBuf,
    environment: CognitionPathEnvironment,
    coordinator: Arc<CognitionWriteCoordinator>,
    now_iso: Arc<dyn Fn() -> String + Send + Sync>,
    unicode_version: String,
    icu_version: String,
) -> CognitionResult<MemoryGenerationHandle> {
    if unicode_version.is_empty() || icu_version.is_empty() {
        return Err(error(CognitionCode::MemoryRuntimeVersionUnavailable));
    }
    let lock_path = environment.consolidation_lock(&data_root);
    let lease = coordinator
        .acquire(
            CognitionWriteAcquire::immediate(lock_path, "cutover"),
            CognitionWaitClass::Background,
        )
        .await
        .map_err(CognitionError::from)?
        .ok_or_else(|| error(CognitionCode::MemoryWriteBusy))?;
    // The worker owns the lease until durable writes finish, even if its
    // awaiting startup future is cancelled.
    tokio::task::spawn_blocking(move || {
        let result = initialize_locked(
            &data_root,
            &environment,
            &now_iso(),
            &unicode_version,
            &icu_version,
        )
        .and_then(|()| resolve_active_generation(&data_root, &environment));
        let released = lease.release(result.is_ok()).map_err(CognitionError::from);
        match (result, released) {
            (Err(error), _) | (Ok(_), Err(error)) => Err(error),
            (Ok(handle), Ok(())) => Ok(handle),
        }
    })
    .await
    .map_err(|source| error(CognitionCode::MemoryGenerationUnavailable).with_source(source))?
}

fn initialize_locked(
    data_root: &std::path::Path,
    environment: &CognitionPathEnvironment,
    now: &str,
    unicode_version: &str,
    icu_version: &str,
) -> CognitionResult<()> {
    let memory_root = environment.memory_root(data_root);
    empty::assert_truly_empty(
        data_root,
        &environment.cognition_root(data_root),
        &memory_root,
    )?;
    write_empty_generation(&memory_root, now, unicode_version, icu_version)
}

fn write_empty_generation(
    memory_root: &std::path::Path,
    now: &str,
    unicode_version: &str,
    icu_version: &str,
) -> CognitionResult<()> {
    let generation_id = uuid::Uuid::new_v4().to_string();
    let root = memory_root.join("generations").join(&generation_id);
    durable::create_dir(&root)?;
    GraphRepository::create_fresh(&root.join("graph.sqlite"), now)?;
    let inventory_hash = format!("{:x}", Sha256::digest(b"[\"memory-source-inventory\"]"));
    let manifest = GenerationManifest::new(
        NewManifest {
            generation_id: &generation_id,
            format: GenerationFormat::V2,
            state: GenerationState::Active,
            origin: InitializationOrigin::Empty,
            canonical_snapshot_id: "empty".into(),
            source_inventory_hash: inventory_hash,
            unaccounted_source_count: 0,
        },
        Some(&RuntimeVersions {
            unicode: unicode_version,
            icu: icu_version,
        }),
    );
    durable::write_json(&root.join("manifest.json"), &manifest)?;
    let active = ActiveDescriptor::new(&generation_id, None, now, ProjectionMode::Running);
    durable::write_json(&memory_root.join("active-generation.json"), &active)
}

fn error(code: CognitionCode) -> CognitionError {
    CognitionError::new(code, code.as_str())
}

/// A fresh-only writer reservation captured before source producers start.
/// Materialization belongs to the memory consumer, outside service readiness.
pub struct FreshMemoryGeneration {
    data_root: PathBuf,
    environment: CognitionPathEnvironment,
    lease: CognitionWriteLease,
    now_iso: Arc<dyn Fn() -> String + Send + Sync>,
    unicode_version: String,
    icu_version: String,
}

/// Inspect eligibility without row scans or writes on existing folders.
/// A fresh folder reserves its writer gate until background publication.
pub async fn prepare_fresh_memory_generation(
    data_root: PathBuf,
    environment: CognitionPathEnvironment,
    coordinator: Arc<CognitionWriteCoordinator>,
    now_iso: Arc<dyn Fn() -> String + Send + Sync>,
    unicode_version: String,
    icu_version: String,
) -> CognitionResult<Option<FreshMemoryGeneration>> {
    let root = data_root.clone();
    let paths = environment.clone();
    let fresh = tokio::task::spawn_blocking(move || {
        // Existing conversation stores are never fresh, even when empty. Do
        // not open SQLite readers (which can create WAL sidecars) or scan rows.
        if butler_turn::conversation::conversation_store_path(&root).exists()
            || empty::has_entries(&paths.memory_root(&root))?
            || empty::has_entries(&root.join("tasks"))?
            || empty::has_entries(&paths.cognition_root(&root).join("box"))?
        {
            return Ok(false);
        }
        if empty::has_entries(&paths.cognition_root(&root).join("rules"))? {
            return Ok(false);
        }
        let feedback = paths.cognition_root(&root).join("feedback/feedback.md");
        match std::fs::metadata(feedback) {
            Ok(metadata) => Ok(metadata.len() == 0),
            Err(source) if source.kind() == std::io::ErrorKind::NotFound => Ok(true),
            Err(source) => {
                Err(error(CognitionCode::MemoryInitializationSourceUnreadable).with_source(source))
            }
        }
    })
    .await
    .map_err(|source| error(CognitionCode::MemoryGenerationUnavailable).with_source(source))??;
    if !fresh {
        return Ok(None);
    }
    // Own the writer gate before runtime producers are admitted. Explicit
    // writes cannot overtake publication and turn this fresh root partial.
    let lease = coordinator
        .acquire(
            CognitionWriteAcquire::immediate(environment.consolidation_lock(&data_root), "cutover"),
            CognitionWaitClass::Background,
        )
        .await
        .map_err(CognitionError::from)?
        .ok_or_else(|| error(CognitionCode::MemoryWriteBusy))?;
    Ok(Some(FreshMemoryGeneration {
        data_root,
        environment,
        lease,
        now_iso,
        unicode_version,
        icu_version,
    }))
}

impl FreshMemoryGeneration {
    /// Publish the captured fresh generation before the consumer begins catch-up.
    pub async fn initialize(self) -> CognitionResult<()> {
        tokio::task::spawn_blocking(move || {
            let root = self.environment.memory_root(&self.data_root);
            // Source producers may have started since preflight. Their new
            // sources will be caught up by the consumer after publication.
            let result = empty::has_entries(&root).and_then(|occupied| {
                if occupied {
                    return Ok(());
                }
                write_empty_generation(
                    &root,
                    &(self.now_iso)(),
                    &self.unicode_version,
                    &self.icu_version,
                )
            });
            let released = self
                .lease
                .release(result.is_ok())
                .map_err(CognitionError::from);
            result.and(released)
        })
        .await
        .map_err(|source| error(CognitionCode::MemoryGenerationUnavailable).with_source(source))?
    }
}
