//! Source-compatible persisted node representative correction before rebuild readiness.

use std::{path::Path, sync::Arc};

use serde_json::{Value, json};
use tokio_util::sync::CancellationToken;

use super::qualification_witness::{CandidateWitness, LiveWitness};
use crate::{
    cognition::{
        CognitionError, CognitionPathEnvironment, CognitionResult, MemoryGenerationTarget,
        assert_mutation_authority, ensure_data_authority,
        generation_vectors::{
            NativeGenerationVectorStore, PreparedRepresentative, prepare_representatives,
        },
        graph::GraphRepository,
        resolve_generation,
    },
    coordination::{CognitionWaitClass, CognitionWriteAcquire, CognitionWriteCoordinator},
};

pub(crate) async fn run(
    data_root: &Path,
    environment: &CognitionPathEnvironment,
    coordinator: Arc<CognitionWriteCoordinator>,
    target: &MemoryGenerationTarget,
    cancellation: &CancellationToken,
) -> CognitionResult<Value> {
    let MemoryGenerationTarget::Rebuild { .. } = target else {
        return Err(error("memory_rebuild_invalid_request"));
    };
    if cancellation.is_cancelled() {
        return Err(error("memory_operation_aborted"));
    }
    let handle = resolve_generation(data_root, environment, target)?;
    if handle.embedding.is_none() {
        return Ok(empty());
    }
    let lock = environment.consolidation_lock(data_root);
    let lance = handle.root.join("butler.lance");
    ensure_data_authority(
        data_root,
        &[
            &lock,
            &handle.root,
            &handle.root.join("manifest.json"),
            &handle.graph_path,
            &lance,
            &lance.join("butler_memory.lance"),
        ],
    )?;
    let live = LiveWitness::open(data_root)?;
    let candidate = CandidateWitness::open(data_root, &handle).await?;
    let graph = GraphRepository::open_readonly(&handle.graph_path)?;
    let evidence = graph.load_vector_representative_evidence(&handle.generation_id)?;
    graph.close()?;
    if cancellation.is_cancelled() {
        return Err(error("memory_operation_aborted"));
    }
    let prepared = prepare_representatives(
        data_root,
        &handle,
        &evidence.current_complete,
        &evidence.superseded,
        cancellation,
    )
    .await?;
    candidate.assert_current(&handle).await?;
    live.assert_current()?;
    if prepared.is_empty() {
        return Ok(empty());
    }
    commit_prepared(PreparedCommit {
        data_root,
        environment,
        coordinator,
        target,
        cancellation,
        handle: &handle,
        live: &live,
        candidate: &candidate,
        prepared,
    })
    .await
}

pub(in crate::cognition::generation) struct PreparedCommit<'a> {
    pub(in crate::cognition::generation) data_root: &'a Path,
    pub(in crate::cognition::generation) environment: &'a CognitionPathEnvironment,
    pub(in crate::cognition::generation) coordinator: Arc<CognitionWriteCoordinator>,
    pub(in crate::cognition::generation) target: &'a MemoryGenerationTarget,
    pub(in crate::cognition::generation) cancellation: &'a CancellationToken,
    pub(in crate::cognition::generation) handle: &'a crate::cognition::MemoryGenerationHandle,
    pub(in crate::cognition::generation) live: &'a LiveWitness,
    pub(in crate::cognition::generation) candidate: &'a CandidateWitness,
    pub(in crate::cognition::generation) prepared: Vec<PreparedRepresentative>,
}

pub(in crate::cognition::generation) async fn commit_prepared(
    input: PreparedCommit<'_>,
) -> CognitionResult<Value> {
    let PreparedCommit {
        data_root,
        environment,
        coordinator,
        target,
        cancellation,
        handle,
        live,
        candidate,
        prepared,
    } = input;
    let lock = environment.consolidation_lock(data_root);
    let lease = coordinator
        .acquire(
            CognitionWriteAcquire {
                lock_path: lock.clone(),
                purpose: Some("rebuild_vector_representative".into()),
                deadline_at_epoch_ms: None,
                cancellation: Some(cancellation.clone()),
            },
            CognitionWaitClass::Background,
        )
        .await
        .map_err(|_| error("memory_write_busy"))?
        .ok_or_else(|| error("memory_write_busy"))?;
    let outcome = async {
        lease.assert_for_path(&lock).map_err(|_| error("memory_write_busy"))?;
        if cancellation.is_cancelled() { return Err(error("memory_operation_aborted")); }
        let current = resolve_generation(data_root, environment, target)?;
        assert_mutation_authority(data_root, environment, target, &current)?;
        if current.graph_path != handle.graph_path || current.embedding.as_ref().map(|v| v.version())
            != handle.embedding.as_ref().map(|v| v.version()) {
            return Err(error("memory_generation_changed"));
        }
        live.assert_current()?;
        candidate.assert_current(&current).await?;
        if cancellation.is_cancelled() { return Err(error("memory_operation_aborted")); }
        let store = NativeGenerationVectorStore::new(data_root.to_owned(), environment.clone());
        let mut affected_unit_ids = prepared.iter()
            .flat_map(|item| item.affected_unit_ids.iter().cloned()).collect::<Vec<_>>();
        let rows = prepared.into_iter().map(|item| item.row).collect::<Vec<_>>();
        let mut repaired_vector_keys = Vec::new();
        for batch in rows.chunks(4) {
            if cancellation.is_cancelled() { return Err(error("memory_operation_aborted")); }
            // An admitted SDK mutation is awaited to completion while this lease remains held.
            store.upsert(&lease, target, &current, batch).await?;
            repaired_vector_keys.extend(batch.iter().map(|row| row.vector_key.clone()));
        }
        repaired_vector_keys.sort();
        affected_unit_ids.sort();
        affected_unit_ids.dedup();
        Ok(json!({"repaired_vector_keys":repaired_vector_keys,"affected_unit_ids":affected_unit_ids}))
    }.await;
    let released = lease
        .release(outcome.is_ok())
        .map_err(|_| error("memory_write_busy"));
    outcome.and_then(|value| {
        released?;
        Ok(value)
    })
}

fn empty() -> Value {
    json!({"repaired_vector_keys":[],"affected_unit_ids":[]})
}
fn error(code: &'static str) -> CognitionError {
    CognitionError::new(code, code)
}
