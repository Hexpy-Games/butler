//! One command-owned serving catchup after a bootstrap rollback.

use crate::cognition::CognitionCode;
use std::{path::Path, sync::Arc};

use serde_json::{Value, json};
use tokio_util::sync::CancellationToken;

use super::build;
use crate::cognition::CognitionError;
use crate::cognition::CognitionPathEnvironment;
use crate::cognition::CognitionRegistrationService;
use crate::cognition::CognitionResult;
use crate::cognition::GenerationVectorAdapter;
use crate::cognition::MemorySyncConsumer;
use crate::cognition::inspect_memory_rebuild;
use crate::cognition::rollback_memory_rebuild;
use crate::coordination::CognitionWriteCoordinator;
use crate::host::{EmbeddingOwner, ProcessEnvironment, ProcessModels, SystemIdentity};
use crate::models::ModelConfigurationClock;
use butler_core::configuration::ConfigurationWrites;
use butler_core::locale::LocaleCollation;

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
            .ok_or_else(|| error(CognitionCode::MemoryGenerationChanged))?;
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
        .ok_or_else(|| error(CognitionCode::MemoryGenerationChanged))?;
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
    let os = nix::sys::utsname::uname()
        .map_err(|source| error(CognitionCode::EnvironmentUnavailable).with_source(source))?;
    let home = std::env::var_os("HOME")
        .map(std::path::PathBuf::from)
        .unwrap_or_default();
    let environment =
        ProcessEnvironment::capture(data_root, &home, &os.release().to_string_lossy());
    let collation = Arc::new(
        LocaleCollation::new("en-US")
            .map_err(|source| error(CognitionCode::LocaleUnavailable).with_source(source))?,
    );
    let models = ProcessModels::new(
        data_root.to_owned(),
        environment.model,
        Arc::new(ConfigurationWrites::new()),
        collation,
    )
    .map_err(|error| CognitionError::new(CognitionCode::ModelSetupFailed, error.code()))?;
    let embedding = Arc::new(EmbeddingOwner::new(data_root.to_owned())?);
    let clock: Arc<dyn Fn() -> String + Send + Sync> = Arc::new(|| SystemIdentity.now_iso());
    let vectors = Arc::new(GenerationVectorAdapter::new(
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
    let consumer = MemorySyncConsumer::new(
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
    let closed = embedding.close().await;
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

fn error(code: CognitionCode) -> CognitionError {
    CognitionError::new(code, code.as_str())
}
