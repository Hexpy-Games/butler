//! Source-compatible cutover of a truly empty native memory root.

pub(super) mod durable;
mod empty;

use std::{path::PathBuf, sync::Arc};

use serde_json::json;
use sha2::{Digest, Sha256};

use super::{MemoryGenerationHandle, read::resolve_active_generation};
use crate::{
    cognition::{
        CognitionError, CognitionPathEnvironment, CognitionResult, graph::GraphRepository,
    },
    coordination::{CognitionWaitClass, CognitionWriteAcquire, CognitionWriteCoordinator},
};

/// Called only for a new isolated data root. Existing descriptors are resolved,
/// never reinitialized; partial roots require a real rebuild.
pub(crate) async fn initialize_empty_memory_generation(
    data_root: PathBuf,
    environment: CognitionPathEnvironment,
    coordinator: Arc<CognitionWriteCoordinator>,
    now_iso: Arc<dyn Fn() -> String + Send + Sync>,
    unicode_version: String,
    icu_version: String,
) -> CognitionResult<MemoryGenerationHandle> {
    if unicode_version.is_empty() || icu_version.is_empty() {
        return Err(error("memory_runtime_version_unavailable"));
    }
    let lock_path = environment.consolidation_lock(&data_root);
    let lease = coordinator
        .acquire(
            CognitionWriteAcquire::immediate(lock_path, "cutover"),
            CognitionWaitClass::Background,
        )
        .await
        .map_err(|e| CognitionError::new(e.code, e.message))?
        .ok_or_else(|| error("memory_write_busy"))?;
    let result = initialize_locked(
        &data_root,
        &environment,
        &now_iso(),
        &unicode_version,
        &icu_version,
    );
    let released = lease
        .release(result.is_ok())
        .map_err(|e| CognitionError::new(e.code, e.message));
    match (result, released) {
        (Err(error), _) => Err(error),
        (Ok(()), Err(error)) => Err(error),
        (Ok(()), Ok(())) => resolve_active_generation(&data_root, &environment),
    }
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
    let manifest = json!({
        "schema":"butler.memory-generation.v2",
        "generation_id":generation_id,
        "format":"v2",
        "state":"active",
        "initialization_origin":"empty",
        "schema_version":3,
        "extraction_version":"memory-extract-v3",
        "ranking_version":2,
        "embedding":null,
        "unicode_version":unicode_version,
        "icu_version":icu_version,
        "canonical_snapshot_id":"empty",
        "canonical_snapshot_path":null,
        "source_inventory_hash":inventory_hash,
        "registered_source_count":0,
        "unaccounted_source_count":0,
        "required_acceptance_passed":false,
    });
    durable::write_json(&root.join("manifest.json"), &manifest)?;
    let active = json!({
        "schema":"butler.memory-active-generation.v2",
        "generation_id":generation_id,
        "previous_generation_id":null,
        "activated_at":now,
        "projection_mode":"running",
    });
    durable::write_json(&memory_root.join("active-generation.json"), &active)
}

fn error(code: &'static str) -> CognitionError {
    CognitionError::new(code, code)
}
