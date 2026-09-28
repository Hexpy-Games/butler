//! Explicit failed-stage reset under the existing generation write authority.
//!
//! Without a repair input every failed semantic window, vector unit, and cache
//! job is reset for retry; with one, only the selected invalid vectors are.

use crate::cognition::CognitionCode;
use std::{fs, path::Path, sync::Arc};

use serde::Serialize;
use tokio_util::sync::CancellationToken;

use super::{MemoryGenerationHandle, MemoryGenerationTarget, read};
use crate::{
    cognition::{
        CognitionError, CognitionPathEnvironment, CognitionResult, assert_mutation_authority,
        ensure_data_authority,
        graph::{GraphRepository, RetryFailedCounts, VectorRepairRequest},
        resolve_generation,
    },
    coordination::{CognitionWriteCoordinator, CognitionWriteLease},
};

/// What a retry reset.
#[derive(Clone, Debug, Serialize)]
pub struct RetriedGeneration {
    /// The generation reset.
    #[serde(rename = "generationId")]
    pub generation_id: String,
    /// Work items reset for retry.
    pub retried: RetryFailedCounts,
}

/// Resets failed work of the serving generation or a building candidate.
pub async fn run(
    data_root: &Path,
    environment: &CognitionPathEnvironment,
    coordinator: Arc<CognitionWriteCoordinator>,
    generation_id: &str,
    repair_input: Option<&Path>,
    now: &str,
    cancellation: &CancellationToken,
) -> CognitionResult<RetriedGeneration> {
    if cancellation.is_cancelled() {
        return Err(error(CognitionCode::MemoryOperationAborted));
    }
    read::safe_generation_id(generation_id)?;
    let request = repair_input.map(read_request).transpose()?;
    let memory_root = environment.memory_root(data_root);
    let target = read::operator_target(&memory_root, generation_id)?;
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
        return Err(error(CognitionCode::MemoryOperationAborted));
    }
    let lease = super::stage::acquire(&coordinator, &lock, "projection", cancellation).await?;
    let retry = Retry {
        data_root: data_root.to_owned(),
        environment: environment.to_owned(),
        generation_id: generation_id.to_owned(),
        target,
        handle,
        lock,
        request,
        now: now.to_owned(),
        cancellation: cancellation.to_owned(),
    };
    super::stage::leased(
        lease,
        CognitionCode::MemoryGenerationUnavailable,
        move |lease| retry.run(lease),
    )
    .await
}

/// The leased reset.
struct Retry {
    data_root: std::path::PathBuf,
    environment: CognitionPathEnvironment,
    generation_id: String,
    target: MemoryGenerationTarget,
    handle: MemoryGenerationHandle,
    lock: std::path::PathBuf,
    request: Option<VectorRepairRequest>,
    now: String,
    cancellation: CancellationToken,
}

impl Retry {
    fn run(self, lease: &CognitionWriteLease) -> CognitionResult<RetriedGeneration> {
        lease
            .assert_for_path(&self.lock)
            .map_err(|source| error(CognitionCode::MemoryWriteBusy).with_source(source))?;
        if self.cancellation.is_cancelled() {
            return Err(error(CognitionCode::MemoryOperationAborted));
        }
        let current = resolve_generation(&self.data_root, &self.environment, &self.target)?;
        assert_mutation_authority(&self.data_root, &self.environment, &self.target, &current)?;
        let version = |handle: &MemoryGenerationHandle| {
            handle
                .embedding
                .as_ref()
                .map(|embedding| embedding.version().to_owned())
        };
        if current.graph_path != self.handle.graph_path
            || version(&current) != version(&self.handle)
        {
            return Err(error(CognitionCode::MemoryGenerationChanged));
        }
        ensure_data_authority(&self.data_root, &[&current.graph_path, &self.lock])?;
        let mut graph = GraphRepository::open(&current.graph_path)?;
        graph.ensure_schema(&self.now)?;
        let retried = match &self.request {
            Some(request) => {
                let version = version(&current)
                    .ok_or_else(|| error(CognitionCode::MemoryVectorRepairPreimageChanged))?;
                RetryFailedCounts {
                    vector_units: graph.repair_selected_invalid_vectors(
                        &self.generation_id,
                        &version,
                        request,
                    )?,
                    ..RetryFailedCounts::default()
                }
            }
            None => graph.retry_failed(&self.generation_id, &self.now)?,
        };
        graph.close()?;
        Ok(RetriedGeneration {
            generation_id: self.generation_id,
            retried,
        })
    }
}

fn read_request(path: &Path) -> CognitionResult<VectorRepairRequest> {
    let bytes = fs::read(path).map_err(|source| {
        error(CognitionCode::MemoryVectorRepairInvalidRequest).with_source(source)
    })?;
    VectorRepairRequest::parse(&bytes)
}

fn error(code: CognitionCode) -> CognitionError {
    CognitionError::new(code, code.as_str())
}
