//! One command-owned serving catchup after a bootstrap rollback.

use butler_memory::cognition::{CognitionCode, CutoverStamp};
use std::{path::Path, sync::Arc};

use serde_json::{Value, json};
use tokio_util::sync::CancellationToken;

use super::build;
use crate::host::{EmbeddingOwner, ProcessEnvironment, ProcessModels, SystemIdentity};
use butler_core::configuration::ConfigurationWrites;
use butler_core::locale::LocaleCollation;
use butler_memory::cognition::{
    CognitionError, CognitionPathEnvironment, CognitionRegistrationService, CognitionResult,
    GenerationFormat, GenerationVectorAdapter, InitializationOrigin, MemorySyncConsumer,
    RollbackOutcome, RollbackStep, inspect_memory_rebuild, rollback_memory_rebuild,
};
use butler_memory::coordination::CognitionWriteCoordinator;
use butler_models::models::ModelConfigurationClock;

pub(super) async fn run(
    data_root: &Path,
    paths: &CognitionPathEnvironment,
    coordinator: Arc<CognitionWriteCoordinator>,
    generation: &str,
    cancellation: &CancellationToken,
) -> CognitionResult<Value> {
    let mut outcome = rollback(data_root, paths, &coordinator, generation, cancellation).await?;
    let mut build = None;
    if let RollbackOutcome::Pending {
        next_step: RollbackStep::Build,
        target_generation_id,
        ..
    } = &outcome
    {
        build = Some(
            build::run(
                data_root,
                paths,
                coordinator.clone(),
                target_generation_id,
                cancellation,
            )
            .await?,
        );
        outcome = rollback(data_root, paths, &coordinator, generation, cancellation).await?;
    }
    let mut result = serde_json::to_value(&outcome)
        .map_err(|source| error(CognitionCode::MemoryGenerationUnavailable).with_source(source))?;
    let RollbackOutcome::Committed {
        descriptor,
        readiness,
        ..
    } = &outcome
    else {
        result["build"] = build.unwrap_or(Value::Null);
        return Ok(result);
    };
    let target = descriptor.generation_id.as_str();
    let first_status = inspect_memory_rebuild(data_root, paths, target)?;
    let bootstrap = first_status.manifest.format == Some(GenerationFormat::V2)
        && first_status.manifest.initialization_origin == Some(InitializationOrigin::Empty)
        && readiness.is_none();
    let catchup = if bootstrap {
        Some(serving_catchup(data_root, paths, coordinator, cancellation).await?)
    } else {
        None
    };
    let status = inspect_memory_rebuild(data_root, paths, target)?;
    let catchup_pending = catchup.as_ref().is_some_and(|value| {
        value["available"] != true || value["scanned"].as_u64().unwrap_or(0) >= 256
    });
    result["rollback_pending"] = json!(
        status.manifest.format == Some(GenerationFormat::V2)
            && (status.projection_pending() || catchup_pending)
    );
    result["target_status"] = json!({
        "available":!status.degraded,
        "reason":status.reason,
        "jobs":status.jobs,
        "windows":status.windows,
        "vectors":status.vectors,
        "cache":status.cache,
    });
    result["catchup"] = catchup.unwrap_or(Value::Null);
    result["build"] = build.unwrap_or(Value::Null);
    Ok(result)
}

/// One rollback attempt toward `generation`, stamped now.
async fn rollback(
    data_root: &Path,
    paths: &CognitionPathEnvironment,
    coordinator: &Arc<CognitionWriteCoordinator>,
    generation: &str,
    cancellation: &CancellationToken,
) -> CognitionResult<RollbackOutcome> {
    rollback_memory_rebuild(
        data_root,
        paths,
        coordinator.clone(),
        Some(generation),
        CutoverStamp {
            now: &SystemIdentity.now_iso(),
            verified_commit: option_env!("BUTLER_MEMORY_VERIFIED_COMMIT"),
        },
        cancellation,
    )
    .await
}

async fn serving_catchup(
    data_root: &Path,
    paths: &CognitionPathEnvironment,
    coordinator: Arc<CognitionWriteCoordinator>,
    cancellation: &CancellationToken,
) -> CognitionResult<Value> {
    let generation = butler_memory::cognition::resolve_active_generation(data_root, paths)?;
    let os = butler_platform::instance::os_release()
        .map_err(|source| error(CognitionCode::EnvironmentUnavailable).with_source(source))?;
    let home = butler_platform::user_dirs::home_dir().unwrap_or_default();
    let environment = ProcessEnvironment::capture(data_root, &home, &os);
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
