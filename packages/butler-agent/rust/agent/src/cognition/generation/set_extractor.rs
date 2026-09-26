//! Set the extractor policy of an inactive building generation.

use std::{path::Path, sync::Arc};

use serde_json::{Value, to_value};
use tokio_util::sync::CancellationToken;

use super::read;
use crate::{
    cognition::{
        CognitionError, CognitionPathEnvironment, CognitionResult, MemoryGenerationTarget,
        assert_mutation_authority, ensure_data_authority,
        graph::{GraphRepository, ProjectionModelPolicyInput},
        resolve_generation,
    },
    coordination::{CognitionWaitClass, CognitionWriteAcquire, CognitionWriteCoordinator},
};

pub(crate) async fn run(
    data_root: &Path,
    environment: &CognitionPathEnvironment,
    coordinator: Arc<CognitionWriteCoordinator>,
    generation_id: &str,
    policy: &ProjectionModelPolicyInput,
    now: &str,
    cancellation: &CancellationToken,
) -> CognitionResult<Value> {
    read::safe_generation_id(generation_id)?;
    let memory_root = environment.memory_root(data_root);
    let descriptor = read::read_descriptor(&memory_root)?;
    let manifest = read::read_manifest(&memory_root, generation_id)?;
    if descriptor.generation_id == generation_id || manifest.state.as_deref() != Some("building") {
        return Err(error("memory_generation_changed"));
    }
    let target = MemoryGenerationTarget::Rebuild {
        generation_id: generation_id.to_owned(),
        canonical_snapshot_id: manifest
            .canonical_snapshot_id
            .ok_or_else(|| error("memory_snapshot_changed"))?,
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
        if current.graph_path != handle.graph_path {
            return Err(error("memory_generation_changed"));
        }
        ensure_data_authority(data_root, &[&current.graph_path, &lock])?;
        let mut graph = GraphRepository::open(&current.graph_path)?;
        graph.ensure_schema(now)?;
        let configured = graph.configure_projection_model_policy(policy, now)?;
        graph.close()?;
        to_value(configured).map_err(|_| error("memory_graph_failed"))
    })();
    let released = lease
        .release(result.is_ok())
        .map_err(|_| error("memory_write_busy"));
    result.and_then(|value| {
        released?;
        Ok(value)
    })
}

fn error(code: &'static str) -> CognitionError {
    CognitionError::new(code, code)
}
