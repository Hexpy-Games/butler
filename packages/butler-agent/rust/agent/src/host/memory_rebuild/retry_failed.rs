//! Operator-requested failed-stage retry using the command-owned write coordinator.

use std::{path::Path, sync::Arc};

use serde_json::{Value, json};
use tokio_util::sync::CancellationToken;

use crate::{
    cognition::{CognitionError, CognitionPathEnvironment, retry_failed_memory_generation},
    coordination::CognitionWriteCoordinator,
    models::ModelConfigurationClock,
};

use super::{SystemIdentity, signals};

pub(super) async fn run(
    data: &Path,
    paths: &CognitionPathEnvironment,
    generation: &str,
    vector_repair_input: Option<&Path>,
) -> Result<Value, CognitionError> {
    let coordinator = Arc::new(
        CognitionWriteCoordinator::new(Arc::new(SystemIdentity))
            .map_err(|error| CognitionError::new(error.code, &error.message))?,
    );
    let cancellation = CancellationToken::new();
    let signal_task = signals(cancellation.clone())
        .map_err(|message| CognitionError::new("native_signal_unavailable", message))?;
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
        json!({"operation":"retry-failed","generationId":outcome["generationId"],"retried":outcome["retried"]})
    })
}
