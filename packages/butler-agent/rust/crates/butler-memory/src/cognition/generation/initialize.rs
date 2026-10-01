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
    coordination::{CognitionWaitClass, CognitionWriteAcquire, CognitionWriteCoordinator},
};

/// Strict empty-root cutover; existing descriptors and partial sources require
/// rebuild. Service bootstrap uses `initialize_fresh_memory_generation`.
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

/// Service bootstrap only: existing/partial memory roots and source-bearing
/// folders retain their migration path. The preflight never takes a write lease.
pub async fn initialize_fresh_memory_generation(
    data_root: PathBuf,
    environment: CognitionPathEnvironment,
    coordinator: Arc<CognitionWriteCoordinator>,
    now_iso: Arc<dyn Fn() -> String + Send + Sync>,
    unicode_version: String,
    icu_version: String,
) -> CognitionResult<()> {
    let root = data_root.clone();
    let paths = environment.clone();
    let fresh = tokio::task::spawn_blocking(move || {
        if empty::has_entries(&paths.memory_root(&root))? {
            return Ok(false);
        }
        match empty::assert_truly_empty(
            &root,
            &paths.cognition_root(&root),
            &paths.memory_root(&root),
        ) {
            Ok(()) => Ok(true),
            Err(error)
                if error.code() == CognitionCode::MemoryInitializationRequiresRebuild.as_str() =>
            {
                Ok(false)
            }
            Err(error) => Err(error),
        }
    })
    .await
    .map_err(|source| error(CognitionCode::MemoryGenerationUnavailable).with_source(source))??;
    if fresh {
        initialize_empty_memory_generation(
            data_root,
            environment,
            coordinator,
            now_iso,
            unicode_version,
            icu_version,
        )
        .await?;
    }
    Ok(())
}
