//! Command-owned candidate input preview and repair.

use std::{path::Path, sync::Arc};

use serde_json::{Value, json};
use tokio_util::sync::CancellationToken;

use super::{SystemIdentity, signals};
use crate::{
    cognition::{
        CandidateInputRepairRequest, CognitionError, CognitionPathEnvironment,
        repair_memory_candidate_inputs,
    },
    coordination::CognitionWriteCoordinator,
    models::ModelConfigurationClock,
};

pub(super) async fn run(
    data: &Path,
    paths: &CognitionPathEnvironment,
    generation: &str,
    input: &Path,
    dry_run: bool,
) -> Result<Value, CognitionError> {
    let coordinator = Arc::new(
        CognitionWriteCoordinator::new(Arc::new(SystemIdentity))
            .map_err(|error| CognitionError::new(error.code, &error.message))?,
    );
    let cancellation = CancellationToken::new();
    let signal_task = signals(cancellation.clone())
        .map_err(|message| CognitionError::new("native_signal_unavailable", message))?;
    let now = SystemIdentity.now_iso();
    let result = repair_memory_candidate_inputs(CandidateInputRepairRequest {
        data_root: data,
        environment: paths,
        coordinator,
        generation_id: generation,
        input_path: input,
        dry_run,
        now: &now,
        cancellation: &cancellation,
    })
    .await;
    signal_task.abort();
    let _ = signal_task.await;
    result.map(|value| {
        json!({"operation":"repair-inputs","generationId":generation,
        "repaired":value["repaired"],"receipts":value["receipts"]})
    })
}
