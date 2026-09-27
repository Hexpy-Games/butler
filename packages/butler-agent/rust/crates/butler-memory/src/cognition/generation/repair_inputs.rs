//! Explicit candidate-input preview and repair for a selected generation.

use crate::cognition::CognitionCode;
use std::{fs, path::Path, sync::Arc};

use serde_json::{Value, to_value};
use tokio_util::sync::CancellationToken;

use super::read;
use crate::cognition::graph::{
    CandidateInputRepairRequest as GraphCandidateInputRepairRequest, GraphRepository,
};
use crate::cognition::{
    CognitionError, CognitionPathEnvironment, CognitionResult, assert_mutation_authority,
    ensure_data_authority, resolve_generation,
};
use crate::coordination::{CognitionWaitClass, CognitionWriteAcquire, CognitionWriteCoordinator};
use butler_turn::conversation::ConversationSourceReader;

pub struct CandidateInputRepairRequest<'a> {
    pub data_root: &'a Path,
    pub environment: &'a CognitionPathEnvironment,
    pub coordinator: Arc<CognitionWriteCoordinator>,
    pub generation_id: &'a str,
    pub input_path: &'a Path,
    pub dry_run: bool,
    pub now: &'a str,
    pub cancellation: &'a CancellationToken,
}

pub async fn run(request: CandidateInputRepairRequest<'_>) -> CognitionResult<Value> {
    let CandidateInputRepairRequest {
        data_root,
        environment,
        coordinator,
        generation_id,
        input_path,
        dry_run,
        now,
        cancellation,
    } = request;
    read::safe_generation_id(generation_id)?;
    let size = fs::metadata(input_path)
        .map_err(|source| {
            error(CognitionCode::MemoryInputRepairInvalidRequest).with_source(source)
        })?
        .len();
    if size > 32 * 1024 {
        return Err(error(CognitionCode::MemoryInputRepairInvalidRequest));
    }
    let bytes = fs::read(input_path).map_err(|source| {
        error(CognitionCode::MemoryInputRepairInvalidRequest).with_source(source)
    })?;
    let request = GraphCandidateInputRepairRequest::parse(&bytes)?;
    let memory_root = environment.memory_root(data_root);
    let target = read::operator_target(&memory_root, generation_id)?;
    let handle = resolve_generation(data_root, environment, &target)?;
    let canonical_path = handle
        .canonical_snapshot_path
        .clone()
        .unwrap_or_else(|| data_root.join("runtime/conversation-store.sqlite"));
    let lock = environment.consolidation_lock(data_root);
    let manifest_path = memory_root
        .join("generations")
        .join(generation_id)
        .join("manifest.json");
    ensure_data_authority(
        data_root,
        &[
            &memory_root,
            &manifest_path,
            &handle.graph_path,
            &canonical_path,
            &handle.source_root,
            &lock,
        ],
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
        .map_err(|source| error(CognitionCode::MemoryWriteBusy).with_source(source))?
        .ok_or_else(|| error(CognitionCode::MemoryWriteBusy))?;
    let data_root = data_root.to_owned();
    let environment = environment.to_owned();
    let generation_id = generation_id.to_owned();
    let now = now.to_owned();
    let cancellation = cancellation.to_owned();
    crate::cognition::generation::stage::leased(
        lease,
        CognitionCode::MemoryGraphFailed,
        move |lease| {
            let data_root = &data_root;
            let environment = &environment;
            let generation_id = &generation_id;
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
            if current.graph_path != handle.graph_path
                || current.source_root != handle.source_root
                || current.canonical_snapshot_path != handle.canonical_snapshot_path
            {
                return Err(error(CognitionCode::MemoryGenerationChanged));
            }
            ensure_data_authority(data_root, &[&current.graph_path, &canonical_path, &lock])?;
            let canonical = ConversationSourceReader::open(&canonical_path)
                .map_err(|source| error(CognitionCode::MemorySourceChanged).with_source(source))?;
            let mut graph = if dry_run {
                GraphRepository::open_readonly(&current.graph_path)?
            } else {
                GraphRepository::open(&current.graph_path)?
            };
            let repaired = graph.repair_candidate_inputs(
                generation_id,
                &canonical,
                &current.source_root,
                &request,
                dry_run,
                now,
            )?;
            graph.close()?;
            to_value(repaired)
                .map_err(|source| error(CognitionCode::MemoryGraphFailed).with_source(source))
        },
    )
    .await
}

fn error(code: CognitionCode) -> CognitionError {
    CognitionError::new(code, code.as_str())
}
