//! Set the extractor policy of an inactive building generation.

use crate::cognition::CognitionCode;
use std::{path::Path, sync::Arc};

use tokio_util::sync::CancellationToken;

use super::read;
use crate::{
    cognition::{
        CognitionError, CognitionPathEnvironment, CognitionResult, assert_mutation_authority,
        ensure_data_authority,
        graph::{GraphRepository, ProjectionModelPolicy, ProjectionModelPolicyInput},
        resolve_generation,
    },
    coordination::CognitionWriteCoordinator,
};

/// Sets the projection model policy of a generation.
pub async fn run(
    data_root: &Path,
    environment: &CognitionPathEnvironment,
    coordinator: Arc<CognitionWriteCoordinator>,
    generation_id: &str,
    policy: &ProjectionModelPolicyInput,
    now: &str,
    cancellation: &CancellationToken,
) -> CognitionResult<ProjectionModelPolicy> {
    read::safe_generation_id(generation_id)?;
    let memory_root = environment.memory_root(data_root);
    let descriptor = read::read_descriptor(&memory_root)?;
    let manifest = read::read_manifest(&memory_root, generation_id)?;
    if descriptor.generation_id == generation_id {
        return Err(error(CognitionCode::MemoryGenerationChanged));
    }
    let target = read::candidate_target(generation_id, manifest)?;
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
    let lease = crate::cognition::generation::stage::acquire(
        &coordinator,
        &lock,
        "projection",
        cancellation,
    )
    .await?;
    let data_root = data_root.to_owned();
    let environment = environment.to_owned();
    let policy = policy.to_owned();
    let now = now.to_owned();
    let cancellation = cancellation.to_owned();
    crate::cognition::generation::stage::leased(
        lease,
        CognitionCode::MemoryGraphFailed,
        move |lease| {
            let data_root = &data_root;
            let environment = &environment;
            let policy = &policy;
            let now = &now;
            let cancellation = &cancellation;
            lease
                .assert_for_path(&lock)
                .map_err(|source| error(CognitionCode::MemoryWriteBusy).with_source(source))?;
            if cancellation.is_cancelled() {
                return Err(error(CognitionCode::MemoryOperationAborted));
            }
            let current = resolve_generation(data_root, environment, &target)?;
            assert_mutation_authority(data_root, environment, &target, &current)?;
            if current.graph_path != handle.graph_path {
                return Err(error(CognitionCode::MemoryGenerationChanged));
            }
            ensure_data_authority(data_root, &[&current.graph_path, &lock])?;
            let mut graph = GraphRepository::open(&current.graph_path)?;
            graph.ensure_schema(now)?;
            let configured = graph.configure_projection_model_policy(policy, now)?;
            graph.close()?;
            Ok(configured)
        },
    )
    .await
}

fn error(code: CognitionCode) -> CognitionError {
    CognitionError::new(code, code.as_str())
}
