//! Bounded snapshot-backed rebuild work without activation.

use std::{collections::HashSet, path::Path, sync::Arc};

use serde_json::{Value, json};
use tokio_util::sync::CancellationToken;

use super::super::{
    NativeEmbeddingOwner, NativeProcessEnvironment, NativeProcessModels, SystemIdentity,
};
use crate::{
    cognition::{
        CognitionError, CognitionPathEnvironment, CognitionRegistrationService, CognitionResult,
        MemoryGenerationTarget, MemorySyncPoll, NativeGenerationVectorAdapter,
        NativeMemorySyncConsumer, RegisterTypedSourceInput, advance_rebuild_cache,
        assert_rebuild_sources_registered, inspect_memory_rebuild, read_build_inventory,
        rebuild_typed_cursor, reconcile_rebuild_vector_representatives, record_rebuild_readiness,
        refresh_memory_rebuild_snapshot, resolve_generation,
    },
    configuration::ConfigurationWrites,
    coordination::CognitionWriteCoordinator,
    locale::LocaleCollation,
    models::ModelConfigurationClock,
};

const MAX_CATCHUP_QUANTA: usize = 4096;
const MAX_TYPED_QUANTA: usize = 4096;
const MAX_PROJECTION_QUANTA: usize = 4096;
const MAX_CACHE_QUANTA: usize = 4096;

pub(super) async fn run(
    data_root: &Path,
    paths: &CognitionPathEnvironment,
    coordinator: Arc<CognitionWriteCoordinator>,
    generation_id: &str,
    cancellation: &CancellationToken,
) -> CognitionResult<Value> {
    refresh_memory_rebuild_snapshot(
        data_root,
        paths,
        coordinator.clone(),
        generation_id,
        &SystemIdentity.now_iso(),
        cancellation,
    )
    .await?;
    let metadata = inspect_memory_rebuild(data_root, paths, generation_id)?;
    let snapshot_id = metadata["manifest"]["canonical_snapshot_id"]
        .as_str()
        .ok_or_else(|| error("memory_snapshot_changed"))?
        .to_owned();
    let target = MemoryGenerationTarget::Rebuild {
        generation_id: generation_id.to_owned(),
        canonical_snapshot_id: snapshot_id.clone(),
    };
    let handle = resolve_generation(data_root, paths, &target)?;
    let inventory = read_build_inventory(data_root, &handle, cancellation)?;
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
        coordinator.clone(),
        clock,
    )
    .with_embedding(embedding.clone())
    .with_rebuild_target(generation_id.to_owned(), snapshot_id);
    let result = work(RebuildWork {
        consumer: &consumer,
        registration: &registration,
        coordinator,
        data_root,
        paths,
        handle: &handle,
        target,
        inventory,
        cancellation,
    })
    .await;
    consumer.close().await;
    registration.close().await;
    let closed = embedding
        .close()
        .await
        .map_err(|e| CognitionError::new(e.code, e.message));
    match (result, closed) {
        (Err(error), _) | (Ok(_), Err(error)) => Err(error),
        (Ok(value), Ok(())) => Ok(value),
    }
}

struct RebuildWork<'a> {
    consumer: &'a NativeMemorySyncConsumer,
    registration: &'a CognitionRegistrationService,
    coordinator: Arc<CognitionWriteCoordinator>,
    data_root: &'a Path,
    paths: &'a CognitionPathEnvironment,
    handle: &'a crate::cognition::MemoryGenerationHandle,
    target: MemoryGenerationTarget,
    inventory: crate::cognition::BuildInventory,
    cancellation: &'a CancellationToken,
}

async fn work(input: RebuildWork<'_>) -> CognitionResult<Value> {
    let RebuildWork {
        consumer,
        registration,
        coordinator,
        data_root,
        paths,
        handle,
        target,
        inventory,
        cancellation,
    } = input;
    let mut seen = HashSet::new();
    let mut catchup_quanta = 0;
    let mut conversation_registered = 0;
    loop {
        if cancellation.is_cancelled() {
            return Err(error("memory_operation_aborted"));
        }
        if catchup_quanta == MAX_CATCHUP_QUANTA {
            return Err(error("memory_rebuild_quantum_budget"));
        }
        let outcome = consumer.catchup_once(cancellation).await?;
        catchup_quanta += 1;
        conversation_registered += outcome.ingested;
        let cursor = (outcome.outcome_cursor, outcome.recovered_message_cursor);
        if outcome.scanned == 0 || !seen.insert(cursor) {
            break;
        }
    }
    let snapshot_id = match &target {
        MemoryGenerationTarget::Rebuild {
            canonical_snapshot_id,
            ..
        } => canonical_snapshot_id,
        MemoryGenerationTarget::Active { .. } => return Err(error("memory_generation_changed")),
    };
    let typed_cursor = rebuild_typed_cursor(handle, snapshot_id)?;
    let start = match typed_cursor {
        None => 0,
        Some(cursor) => inventory
            .typed
            .iter()
            .position(|item| item.source_key() == cursor)
            .map(|index| index + 1)
            .ok_or_else(|| error("memory_source_changed"))?,
    };
    let mut typed_registered = 0;
    for record in inventory.typed.iter().skip(start).take(MAX_TYPED_QUANTA) {
        if cancellation.is_cancelled() {
            return Err(error("memory_operation_aborted"));
        }
        registration
            .register_typed_source(RegisterTypedSourceInput {
                data_root: data_root.to_owned(),
                target: target.clone(),
                source_kind: record.source_kind.clone(),
                record_id: record.record_id.clone(),
                revision: record.revision.clone(),
                operation_id: record.operation_id.clone(),
                content_hash: record.content_hash.clone(),
                completion_id: format!("rebuild:typed:{}", record.operation_id),
                cancellation: cancellation.child_token(),
            })
            .await?;
        typed_registered += 1;
    }
    if inventory.typed.len().saturating_sub(start) > MAX_TYPED_QUANTA {
        return Err(error("memory_rebuild_quantum_budget"));
    }
    assert_rebuild_sources_registered(handle, &inventory)?;
    let mut projection_quanta = 0;
    loop {
        if cancellation.is_cancelled() {
            return Err(error("memory_operation_aborted"));
        }
        if projection_quanta == MAX_PROJECTION_QUANTA {
            return Err(error("memory_rebuild_quantum_budget"));
        }
        match consumer.poll_once().await? {
            MemorySyncPoll::Processed => projection_quanta += 1,
            MemorySyncPoll::Idle => break,
            MemorySyncPoll::Deferred => return Err(error("memory_write_busy")),
        }
    }
    let mut cache_quanta = 0;
    loop {
        if cancellation.is_cancelled() {
            return Err(error("memory_operation_aborted"));
        }
        if cache_quanta == MAX_CACHE_QUANTA {
            return Err(error("memory_rebuild_quantum_budget"));
        }
        if !advance_rebuild_cache(data_root, paths, coordinator.clone(), &target, cancellation)
            .await?
        {
            break;
        }
        cache_quanta += 1;
    }
    let vector_reconciliation = reconcile_rebuild_vector_representatives(
        data_root,
        paths,
        coordinator.clone(),
        &target,
        cancellation,
    )
    .await?;
    let readiness =
        record_rebuild_readiness(data_root, paths, coordinator, &target, cancellation).await?;
    let inspected = inspect_memory_rebuild(data_root, paths, &handle.generation_id)?;
    Ok(json!({
        "generationId":handle.generation_id,"canonicalSnapshotId":match target {MemoryGenerationTarget::Rebuild {canonical_snapshot_id,..}=>Some(canonical_snapshot_id),MemoryGenerationTarget::Active { .. }=>None},
        "inventorySourceCount":inventory.expected_source_count,
        "catchupQuanta":catchup_quanta,"conversationRegistered":conversation_registered,
        "typedRegistered":typed_registered,"projectionQuanta":projection_quanta,"cacheQuanta":cache_quanta,
        "ready":readiness["ready"],"readiness":readiness,"inspect":inspected,
        "vector_reconciliation":vector_reconciliation,
    }))
}
fn error(code: &'static str) -> CognitionError {
    CognitionError::new(code, code)
}
