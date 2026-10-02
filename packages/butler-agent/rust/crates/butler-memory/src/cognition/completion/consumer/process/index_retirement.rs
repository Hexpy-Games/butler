//! Background-only schema retirement; no lease is requested after completion.
use super::Input;
use crate::cognition::{
    CognitionCode, CognitionError, CognitionResult, MemoryGenerationTarget,
    assert_mutation_authority, ensure_data_authority, graph::GraphRepository,
    resolve_active_generation,
};
use crate::coordination::{CognitionWaitClass, CognitionWriteAcquire};

pub(super) async fn process(input: &Input) -> CognitionResult<bool> {
    let owned = input.clone();
    let handle = super::super::blocking::run(move || {
        resolve_active_generation(&owned.data_root, &owned.environment)
    })
    .await?;
    if input
        .probe
        .obsolete_alias_index(&handle.graph_path)
        .await?
        .is_none()
    {
        return Ok(false);
    }
    let lock = input.environment.consolidation_lock(&input.data_root);
    let owned = input.clone();
    let checked = handle.clone();
    let checked_lock = lock.clone();
    super::super::blocking::run(move || {
        ensure_data_authority(
            &owned.data_root,
            &[&checked_lock, &checked.root, &checked.graph_path],
        )
    })
    .await?;
    let lease = input
        .coordinator
        .acquire(
            CognitionWriteAcquire {
                lock_path: lock.clone(),
                purpose: Some("alias_index_retirement".into()),
                deadline_at_epoch_ms: None,
                cancellation: Some(input.shutdown.clone()),
            },
            CognitionWaitClass::Background,
        )
        .await
        .map_err(CognitionError::from)?;
    let Some(lease) = lease else {
        return Ok(false);
    };
    let owned = input.clone();
    super::super::blocking::run(move || run(&owned, handle.generation_id, &lock, lease))
        .await
        .map_err(|source| {
            CognitionError::new(
                CognitionCode::MemorySyncOperationFailed,
                "memory_sync_operation_failed",
            )
            .with_source(source)
        })
}

fn run(
    input: &Input,
    expected_generation: String,
    lock: &std::path::Path,
    lease: crate::coordination::CognitionWriteLease,
) -> CognitionResult<bool> {
    let result = (|| {
        lease.assert_for_path(lock).map_err(CognitionError::from)?;
        let current = resolve_active_generation(&input.data_root, &input.environment)?;
        let target = MemoryGenerationTarget::Active {
            expected_generation,
        };
        assert_mutation_authority(&input.data_root, &input.environment, &target, &current)?;
        let graph = GraphRepository::open(&current.graph_path)?;
        let dropped = graph.drop_obsolete_alias_index(&input.shutdown)?;
        graph.close()?;
        Ok(dropped)
    })();
    let released = lease.release(result.is_ok()).map_err(CognitionError::from);
    result.and_then(|value| {
        released?;
        Ok(value)
    })
}
