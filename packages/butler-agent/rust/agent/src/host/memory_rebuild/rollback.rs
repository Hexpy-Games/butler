//! One command-owned serving catchup after a bootstrap rollback.

use std::{path::Path, sync::Arc};

use serde_json::{Value, json};
use tokio_util::sync::CancellationToken;

use super::build;
use crate::host::{
    NativeEmbeddingOwner, NativeProcessEnvironment, NativeProcessModels, SystemIdentity,
};
use crate::{
    cognition::{
        CognitionError, CognitionPathEnvironment, CognitionRegistrationService, CognitionResult,
        NativeGenerationVectorAdapter, NativeMemorySyncConsumer, inspect_memory_rebuild,
        rollback_memory_rebuild,
    },
    configuration::ConfigurationWrites,
    coordination::CognitionWriteCoordinator,
    locale::LocaleCollation,
    models::ModelConfigurationClock,
};

pub(super) async fn run(
    data_root: &Path,
    paths: &CognitionPathEnvironment,
    coordinator: Arc<CognitionWriteCoordinator>,
    generation: &str,
    cancellation: &CancellationToken,
) -> CognitionResult<Value> {
    let mut result = rollback_memory_rebuild(
        data_root,
        paths,
        coordinator.clone(),
        Some(generation),
        &SystemIdentity.now_iso(),
        cancellation,
    )
    .await?;
    let mut build = None;
    if result["next_step"] == "build" {
        let target = result["target_generation_id"]
            .as_str()
            .ok_or_else(|| error("memory_generation_changed"))?;
        build =
            Some(build::run(data_root, paths, coordinator.clone(), target, cancellation).await?);
        result = rollback_memory_rebuild(
            data_root,
            paths,
            coordinator.clone(),
            Some(generation),
            &SystemIdentity.now_iso(),
            cancellation,
        )
        .await?;
    }
    if result.get("descriptor").is_none() {
        result["build"] = build.unwrap_or(Value::Null);
        return Ok(result);
    }
    let target = result["descriptor"]["generation_id"]
        .as_str()
        .ok_or_else(|| error("memory_generation_changed"))?;
    let first_status = inspect_memory_rebuild(data_root, paths, target)?;
    let bootstrap = first_status["manifest"]["format"] == "v2"
        && first_status["manifest"]["initialization_origin"] == "empty"
        && result["readiness"].is_null();
    let catchup = if bootstrap {
        Some(serving_catchup(data_root, paths, coordinator, cancellation).await?)
    } else {
        None
    };
    let status = inspect_memory_rebuild(data_root, paths, target)?;
    let projection_pending = status["degraded"] == true
        || !status["windows"].is_object()
        || !status["vectors"].is_object()
        || !status["cache"].is_object()
        || ["windows", "vectors", "cache"].iter().any(|phase| {
            status[*phase]["pending"].as_u64().unwrap_or(0) > 0
                || status[*phase]["failed"].as_u64().unwrap_or(0) > 0
        });
    let catchup_pending = catchup.as_ref().is_some_and(|value| {
        value["available"] != true || value["scanned"].as_u64().unwrap_or(0) >= 256
    });
    result["rollback_pending"] =
        json!(status["manifest"]["format"] == "v2" && (projection_pending || catchup_pending));
    result["target_status"] = json!({
        "available":status["degraded"] != true,
        "reason":status["reason"],
        "jobs":status["jobs"],
        "windows":status["windows"],
        "vectors":status["vectors"],
        "cache":status["cache"],
    });
    result["catchup"] = catchup.unwrap_or(Value::Null);
    result["build"] = build.unwrap_or(Value::Null);
    Ok(result)
}

async fn serving_catchup(
    data_root: &Path,
    paths: &CognitionPathEnvironment,
    coordinator: Arc<CognitionWriteCoordinator>,
    cancellation: &CancellationToken,
) -> CognitionResult<Value> {
    let generation = crate::cognition::resolve_active_generation(data_root, paths)?;
    let os = nix::sys::utsname::uname().map_err(|_| error("native_environment_unavailable"))?;
    let home = std::env::var_os("HOME")
        .map(std::path::PathBuf::from)
        .unwrap_or_default();
    let environment =
        NativeProcessEnvironment::capture(data_root, &home, &os.release().to_string_lossy());
    let collation =
        Arc::new(LocaleCollation::new("en-US").map_err(|_| error("native_locale_unavailable"))?);
    let models = NativeProcessModels::new(
        data_root.to_owned(),
        environment.model,
        Arc::new(ConfigurationWrites::new()),
        collation,
    )
    .map_err(|error| CognitionError::new("native_model_setup_failed", error.code))?;
    let embedding = Arc::new(NativeEmbeddingOwner::new(data_root.to_owned())?);
    let clock: Arc<dyn Fn() -> String + Send + Sync> = Arc::new(|| SystemIdentity.now_iso());
    let vectors = Arc::new(NativeGenerationVectorAdapter::new(
        data_root.to_owned(),
        paths.clone(),
        embedding.clone(),
    ));
    let registration = Arc::new(CognitionRegistrationService::with_projection(
        paths.clone(),
        coordinator.clone(),
        clock.clone(),
        models.provider.clone(),
        vectors,
        Arc::new(SystemIdentity),
    ));
    let consumer = NativeMemorySyncConsumer::new(
        data_root.to_owned(),
        paths.clone(),
        registration.clone(),
        coordinator,
        clock,
    )
    .with_embedding(embedding.clone());
    let result = consumer.catchup_once(cancellation).await;
    consumer.close().await;
    registration.close().await;
    let closed = embedding
        .close()
        .await
        .map_err(|error| CognitionError::new(error.code, error.message));
    let report = result?;
    closed?;
    Ok(json!({
        "available":report.available,
        "reason":if report.available {Value::Null} else {json!("canonical_reader_unavailable")},
        "scanned":report.scanned,"ingested":report.ingested,"wrapped":report.wrapped,
        "state":{"outcomeCursor":report.outcome_cursor,"recoveredMessageCursor":report.recovered_message_cursor},
        "generationId":generation.generation_id,
    }))
}

fn error(code: &'static str) -> CognitionError {
    CognitionError::new(code, code)
}
