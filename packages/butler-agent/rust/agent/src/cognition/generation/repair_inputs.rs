//! Explicit candidate-input preview and repair for a selected generation.

use std::{fs, path::Path, sync::Arc};

use serde_json::{Value, to_value};
use tokio_util::sync::CancellationToken;

use super::read;
use crate::{
    cognition::{
        CognitionError, CognitionPathEnvironment, CognitionResult, MemoryGenerationTarget,
        assert_mutation_authority, ensure_data_authority,
        graph::{CandidateInputRepairRequest as GraphCandidateInputRepairRequest, GraphRepository},
        resolve_generation,
    },
    conversation::ConversationSourceReader,
    coordination::{CognitionWaitClass, CognitionWriteAcquire, CognitionWriteCoordinator},
};

pub(crate) struct CandidateInputRepairRequest<'a> {
    pub data_root: &'a Path,
    pub environment: &'a CognitionPathEnvironment,
    pub coordinator: Arc<CognitionWriteCoordinator>,
    pub generation_id: &'a str,
    pub input_path: &'a Path,
    pub dry_run: bool,
    pub now: &'a str,
    pub cancellation: &'a CancellationToken,
}

pub(crate) async fn run(request: CandidateInputRepairRequest<'_>) -> CognitionResult<Value> {
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
        .map_err(|_| error("memory_input_repair_invalid_request"))?
        .len();
    if size > 32 * 1024 {
        return Err(error("memory_input_repair_invalid_request"));
    }
    let bytes = fs::read(input_path).map_err(|_| error("memory_input_repair_invalid_request"))?;
    let request = GraphCandidateInputRepairRequest::parse(&bytes)?;
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
            || current.source_root != handle.source_root
            || current.canonical_snapshot_path != handle.canonical_snapshot_path
        {
            return Err(error("memory_generation_changed"));
        }
        ensure_data_authority(data_root, &[&current.graph_path, &canonical_path, &lock])?;
        let canonical = ConversationSourceReader::open(&canonical_path)
            .map_err(|_| error("memory_source_changed"))?;
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
        to_value(repaired).map_err(|_| error("memory_graph_failed"))
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
