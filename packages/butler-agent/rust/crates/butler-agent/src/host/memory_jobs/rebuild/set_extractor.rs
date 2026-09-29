//! Validate current model metadata before writing a building generation policy.

use butler_memory::cognition::CognitionCode;
use std::{path::Path, sync::Arc};

use serde_json::{Value, json};
use tokio_util::sync::CancellationToken;

use super::{SystemIdentity, signals};
use crate::host::{ProcessEnvironment, ProcessModels};
use butler_core::configuration::ConfigurationWrites;
use butler_core::locale::LocaleCollation;
use butler_memory::cognition::{
    CognitionError, CognitionPathEnvironment, ProjectionModelPolicyInput,
    set_extractor_memory_generation,
};
use butler_memory::coordination::CognitionWriteCoordinator;
use butler_models::models::{ModelConfigurationClock, ReasoningEffort};

pub(super) async fn run(
    data: &Path,
    paths: &CognitionPathEnvironment,
    generation: &str,
    policy: ProjectionModelPolicyInput,
) -> Result<Value, CognitionError> {
    if policy.primary_model == policy.fallback_model {
        return Err(error(CognitionCode::MemoryRebuildInvalidModelPolicy));
    }
    let os = butler_platform::instance::os_release()
        .map_err(|source| error(CognitionCode::EnvironmentUnavailable).with_source(source))?;
    let home = butler_platform::user_dirs::home_dir().unwrap_or_default();
    let environment = ProcessEnvironment::capture(data, &home, &os);
    let collation = Arc::new(
        LocaleCollation::new("en-US")
            .map_err(|source| error(CognitionCode::LocaleUnavailable).with_source(source))?,
    );
    let models = ProcessModels::new(
        data.to_owned(),
        environment.model,
        Arc::new(ConfigurationWrites::new()),
        collation,
    )
    .map_err(|source| error(CognitionCode::ModelSetupFailed).with_source(source))?;
    let current = models
        .configuration
        .read()
        .await
        .map_err(|source| error(CognitionCode::ModelSetupFailed).with_source(source))?;
    for (model, effort) in [
        (&policy.primary_model, &policy.primary_effort),
        (&policy.fallback_model, &policy.fallback_effort),
    ] {
        let Some(metadata) = current.catalog.find_model_metadata(Some(model)) else {
            return Err(error(CognitionCode::MemoryRebuildInvalidModelPolicy));
        };
        let parsed =
            serde_json::from_value::<ReasoningEffort>(json!(effort)).map_err(|source| {
                error(CognitionCode::MemoryRebuildInvalidModelPolicy).with_source(source)
            })?;
        if !metadata.runtime_supported || !metadata.reasoning_efforts.contains(&parsed) {
            return Err(error(CognitionCode::MemoryRebuildInvalidModelPolicy));
        }
    }
    let coordinator = Arc::new(
        CognitionWriteCoordinator::new(Arc::new(SystemIdentity)).map_err(CognitionError::from)?,
    );
    let cancellation = CancellationToken::new();
    let signal_task = signals(cancellation.clone()).map_err(|message| {
        CognitionError::new(CognitionCode::SignalUnavailable, message.to_string())
            .with_source(message)
    })?;
    let result = set_extractor_memory_generation(
        data,
        paths,
        coordinator,
        generation,
        &policy,
        &SystemIdentity.now_iso(),
        &cancellation,
    )
    .await;
    signal_task.abort();
    let _ = signal_task.await;
    result.map(
        |policy| json!({"operation":"set-extractor","generationId":generation,"policy":policy}),
    )
}

fn error(code: CognitionCode) -> CognitionError {
    CognitionError::new(code, code.as_str())
}
