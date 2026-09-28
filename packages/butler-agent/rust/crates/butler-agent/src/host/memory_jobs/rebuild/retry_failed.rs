//! Operator-requested failed-stage retry using the command-owned write coordinator.

use std::{path::Path, sync::Arc};

use serde_json::{Value, json};
use tokio_util::sync::CancellationToken;

use butler_memory::cognition::{
    CognitionError, CognitionPathEnvironment, retry_failed_memory_generation,
};
use butler_memory::coordination::CognitionWriteCoordinator;
use butler_models::models::ModelConfigurationClock;

use super::{SystemIdentity, signals};
use butler_memory::cognition::CognitionCode;

pub(super) async fn run(
    data: &Path,
    paths: &CognitionPathEnvironment,
    generation: &str,
    vector_repair_input: Option<&Path>,
) -> Result<Value, CognitionError> {
    let coordinator = Arc::new(
        CognitionWriteCoordinator::new(Arc::new(SystemIdentity)).map_err(CognitionError::from)?,
    );
    let cancellation = CancellationToken::new();
    let signal_task = signals(cancellation.clone()).map_err(|message| {
        CognitionError::new(CognitionCode::SignalUnavailable, message.to_string())
            .with_source(message)
    })?;
    let result = retry_failed_memory_generation(
        data,
        paths,
        coordinator,
        generation,
        vector_repair_input,
        &SystemIdentity.now_iso(),
        &cancellation,
    )
    .await;
    signal_task.abort();
    let _ = signal_task.await;
    result.map(|outcome| {
        json!({"operation":"retry-failed","generationId":outcome.generation_id,"retried":outcome.retried})
    })
}
