//! Explicit candidate-input preview and repair for a selected generation.

use crate::cognition::CognitionCode;
use std::{
    fs,
    path::{Path, PathBuf},
    sync::Arc,
};

use tokio_util::sync::CancellationToken;

use super::{MemoryGenerationHandle, MemoryGenerationTarget, read};
use crate::cognition::graph::{
    CandidateInputRepairRequest as GraphCandidateInputRepairRequest, CandidateInputRepairResult,
    GraphRepository, RepairMode,
};
use crate::cognition::{
    CognitionError, CognitionPathEnvironment, CognitionResult, assert_mutation_authority,
    ensure_data_authority, resolve_generation,
};
use crate::coordination::{CognitionWriteCoordinator, CognitionWriteLease};
use butler_turn::conversation::ConversationSourceReader;

/// Largest repair input file accepted.
const MAX_INPUT_BYTES: u64 = 32 * 1024;

/// An operator request to preview or repair pinned candidate inputs.
pub struct CandidateInputRepairRequest<'a> {
    /// The DATA root.
    pub data_root: &'a Path,
    /// Memory path overrides.
    pub environment: &'a CognitionPathEnvironment,
    /// Memory write coordination.
    pub coordinator: Arc<CognitionWriteCoordinator>,
    /// The generation to repair.
    pub generation_id: &'a str,
    /// The repair request file.
    pub input_path: &'a Path,
    /// Whether to only preview the repair.
    pub mode: RepairMode,
    /// Repair timestamp.
    pub now: &'a str,
    /// Stops the repair between steps.
    pub cancellation: &'a CancellationToken,
}

/// Previews or applies a candidate-input repair under the projection lease.
pub async fn run(
    request: CandidateInputRepairRequest<'_>,
) -> CognitionResult<CandidateInputRepairResult> {
    let CandidateInputRepairRequest {
        data_root,
        environment,
        coordinator,
        generation_id,
        input_path,
        mode,
        now,
        cancellation,
    } = request;
    read::safe_generation_id(generation_id)?;
    let repair = read_repair_request(input_path)?;
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
    let lease = super::stage::acquire(&coordinator, &lock, "projection", cancellation).await?;
    let job = Repair {
        data_root: data_root.to_owned(),
        environment: environment.to_owned(),
        generation_id: generation_id.to_owned(),
        target,
        handle,
        canonical_path,
        lock,
        request: repair,
        mode,
        now: now.to_owned(),
        cancellation: cancellation.to_owned(),
    };
    super::stage::leased(lease, CognitionCode::MemoryGraphFailed, move |lease| {
        job.run(lease)
    })
    .await
}

fn read_repair_request(input_path: &Path) -> CognitionResult<GraphCandidateInputRepairRequest> {
    let invalid =
        |source| error(CognitionCode::MemoryInputRepairInvalidRequest).with_source(source);
    let size = fs::metadata(input_path).map_err(invalid)?.len();
    if size > MAX_INPUT_BYTES {
        return Err(error(CognitionCode::MemoryInputRepairInvalidRequest));
    }
    GraphCandidateInputRepairRequest::parse(&fs::read(input_path).map_err(invalid)?)
}

/// The leased repair.
struct Repair {
    data_root: PathBuf,
    environment: CognitionPathEnvironment,
    generation_id: String,
    target: MemoryGenerationTarget,
    handle: MemoryGenerationHandle,
    canonical_path: PathBuf,
    lock: PathBuf,
    request: GraphCandidateInputRepairRequest,
    mode: RepairMode,
    now: String,
    cancellation: CancellationToken,
}

impl Repair {
    fn run(self, lease: &CognitionWriteLease) -> CognitionResult<CandidateInputRepairResult> {
        lease
            .assert_for_path(&self.lock)
            .map_err(|source| error(CognitionCode::MemoryWriteBusy).with_source(source))?;
        if self.cancellation.is_cancelled() {
            return Err(error(CognitionCode::MemoryOperationAborted));
        }
        let current = resolve_generation(&self.data_root, &self.environment, &self.target)?;
        assert_mutation_authority(&self.data_root, &self.environment, &self.target, &current)?;
        if current.graph_path != self.handle.graph_path
            || current.source_root != self.handle.source_root
            || current.canonical_snapshot_path != self.handle.canonical_snapshot_path
        {
            return Err(error(CognitionCode::MemoryGenerationChanged));
        }
        ensure_data_authority(
            &self.data_root,
            &[&current.graph_path, &self.canonical_path, &self.lock],
        )?;
        let canonical = ConversationSourceReader::open(&self.canonical_path)
            .map_err(|source| error(CognitionCode::MemorySourceChanged).with_source(source))?;
        let mut graph = match self.mode {
            RepairMode::Preview => GraphRepository::open_readonly(&current.graph_path)?,
            RepairMode::Apply => GraphRepository::open(&current.graph_path)?,
        };
        let repaired = graph.repair_candidate_inputs(
            &self.generation_id,
            &canonical,
            &current.source_root,
            &self.request,
            self.mode,
            &self.now,
        )?;
        graph.close()?;
        Ok(repaired)
    }
}

fn error(code: CognitionCode) -> CognitionError {
    CognitionError::new(code, code.as_str())
}
