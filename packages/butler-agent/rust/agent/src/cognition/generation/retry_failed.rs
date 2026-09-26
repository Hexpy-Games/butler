//! Explicit failed-stage reset under the existing generation write authority.

use std::{fs, path::Path, sync::Arc};

use serde_json::{Value, json};
use tokio_util::sync::CancellationToken;

use super::read;
use crate::{
    cognition::{
        CognitionError, CognitionPathEnvironment, CognitionResult, MemoryGenerationTarget,
        assert_mutation_authority, ensure_data_authority,
        graph::{GraphRepository, VectorRepairRequest},
        resolve_generation,
    },
    coordination::{CognitionWaitClass, CognitionWriteAcquire, CognitionWriteCoordinator},
};

pub(crate) async fn run(
    data_root: &Path,
    environment: &CognitionPathEnvironment,
    coordinator: Arc<CognitionWriteCoordinator>,
    generation_id: &str,
    repair_input: Option<&Path>,
    now: &str,
    cancellation: &CancellationToken,
) -> CognitionResult<Value> {
    if cancellation.is_cancelled() {
        return Err(error("memory_operation_aborted"));
    }
    read::safe_generation_id(generation_id)?;
    let request = repair_input.map(read_request).transpose()?;
    let memory_root = environment.memory_root(data_root);
    let descriptor = read::read_descriptor(&memory_root)?;
    let manifest = read::read_manifest(&memory_root, generation_id)?;
    let target = if descriptor.generation_id == generation_id {
        MemoryGenerationTarget::Active {
            expected_generation: generation_id.to_owned(),
        }
    } else if manifest.state.as_deref() == Some("building") {
        MemoryGenerationTarget::Rebuild {
            generation_id: generation_id.to_owned(),
            canonical_snapshot_id: manifest
                .canonical_snapshot_id
                .ok_or_else(|| error("memory_snapshot_changed"))?,
        }
    } else {
        return Err(error("memory_generation_changed"));
    };
    let handle = resolve_generation(data_root, environment, &target)?;
    let lock = environment.consolidation_lock(data_root);
    let manifest_path = memory_root
        .join("generations")
        .join(generation_id)
        .join("manifest.json");
    ensure_data_authority(
        data_root,
        &[&memory_root, &manifest_path, &handle.graph_path, &lock],
    )?;
    if cancellation.is_cancelled() {
        return Err(error("memory_operation_aborted"));
    }
    let lease = coordinator
        .acquire(
            CognitionWriteAcquire {
                lock_path: lock.clone(),
                purpose: Some("projection".into()),
                deadline_at_epoch_ms: None,
                cancellation: Some(cancellation.clone()),
            },
            CognitionWaitClass::Background,
        )
        .await
        .map_err(|_| error("memory_write_busy"))?
        .ok_or_else(|| error("memory_write_busy"))?;
    let result = (|| {
        lease
            .assert_for_path(&lock)
            .map_err(|_| error("memory_write_busy"))?;
        if cancellation.is_cancelled() {
            return Err(error("memory_operation_aborted"));
        }
        let current = resolve_generation(data_root, environment, &target)?;
        assert_mutation_authority(data_root, environment, &target, &current)?;
        if current.graph_path != handle.graph_path
            || current
                .embedding
                .as_ref()
                .map(super::types::GenerationEmbedding::version)
                != handle
                    .embedding
                    .as_ref()
                    .map(super::types::GenerationEmbedding::version)
        {
            return Err(error("memory_generation_changed"));
        }
        ensure_data_authority(data_root, &[&current.graph_path, &lock])?;
        let mut graph = GraphRepository::open(&current.graph_path)?;
        graph.ensure_schema(now)?;
        let updated = if let Some(request) = &request {
            let version = current
                .embedding
                .as_ref()
                .map(super::types::GenerationEmbedding::version)
                .ok_or_else(|| error("memory_vector_repair_preimage_changed"))?;
            let count = graph.repair_selected_invalid_vectors(generation_id, version, request)?;
            json!({"semantic_windows":0,"vector_units":count,"cache_jobs":0})
        } else {
            let counts = graph.retry_failed(generation_id, now)?;
            json!({"semantic_windows":counts.semantic_windows,
                "vector_units":counts.vector_units,"cache_jobs":counts.cache_jobs})
        };
        graph.close()?;
        Ok(json!({"generationId":generation_id,"retried":updated}))
    })();
    let released = lease
        .release(result.is_ok())
        .map_err(|_| error("memory_write_busy"));
    result.and_then(|value| {
        released?;
        Ok(value)
    })
}

fn read_request(path: &Path) -> CognitionResult<VectorRepairRequest> {
    let value: Value = serde_json::from_slice(
        &fs::read(path).map_err(|_| error("memory_vector_repair_invalid_request"))?,
    )
    .map_err(|_| error("memory_vector_repair_invalid_request"))?;
    VectorRepairRequest::parse(value)
}

fn error(code: &'static str) -> CognitionError {
    CognitionError::new(code, code)
}
