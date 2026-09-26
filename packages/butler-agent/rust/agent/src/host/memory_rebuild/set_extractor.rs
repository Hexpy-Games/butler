//! Validate current model metadata before writing a building generation policy.

use std::{path::Path, sync::Arc};

use serde_json::{Value, json};
use tokio_util::sync::CancellationToken;

use super::{SystemIdentity, signals};
use crate::host::{NativeProcessEnvironment, NativeProcessModels};
use crate::{
    cognition::{
        CognitionError, CognitionPathEnvironment, ProjectionModelPolicyInput,
        set_extractor_memory_generation,
    },
    configuration::ConfigurationWrites,
    coordination::CognitionWriteCoordinator,
    locale::LocaleCollation,
    models::{ModelConfigurationClock, ReasoningEffort},
};

pub(super) async fn run(
    data: &Path,
    paths: &CognitionPathEnvironment,
    generation: &str,
    policy: ProjectionModelPolicyInput,
) -> Result<Value, CognitionError> {
    if policy.primary_model == policy.fallback_model {
        return Err(error("memory_rebuild_invalid_model_policy"));
    }
    let os = nix::sys::utsname::uname().map_err(|_| error("native_environment_unavailable"))?;
    let home = std::env::var_os("HOME")
        .map(std::path::PathBuf::from)
        .unwrap_or_default();
    let environment =
        NativeProcessEnvironment::capture(data, &home, &os.release().to_string_lossy());
    let collation =
        Arc::new(LocaleCollation::new("en-US").map_err(|_| error("native_locale_unavailable"))?);
    let models = NativeProcessModels::new(
        data.to_owned(),
        environment.model,
        Arc::new(ConfigurationWrites::new()),
        collation,
    )
    .map_err(|_| error("native_model_setup_failed"))?;
    let current = models
        .configuration
        .read()
        .await
        .map_err(|_| error("native_model_setup_failed"))?;
    for (model, effort) in [
        (&policy.primary_model, &policy.primary_effort),
        (&policy.fallback_model, &policy.fallback_effort),
    ] {
        let Some(metadata) = current.catalog.find_model_metadata(Some(model)) else {
            return Err(error("memory_rebuild_invalid_model_policy"));
        };
        let parsed = serde_json::from_value::<ReasoningEffort>(json!(effort))
            .map_err(|_| error("memory_rebuild_invalid_model_policy"))?;
        if !metadata.runtime_supported || !metadata.reasoning_efforts.contains(&parsed) {
            return Err(error("memory_rebuild_invalid_model_policy"));
        }
    }
    let coordinator = Arc::new(
        CognitionWriteCoordinator::new(Arc::new(SystemIdentity))
            .map_err(|error| CognitionError::new(error.code, &error.message))?,
    );
    let cancellation = CancellationToken::new();
    let signal_task = signals(cancellation.clone())
        .map_err(|message| CognitionError::new("native_signal_unavailable", message))?;
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

fn error(code: &'static str) -> CognitionError {
    CognitionError::new(code, code)
}
