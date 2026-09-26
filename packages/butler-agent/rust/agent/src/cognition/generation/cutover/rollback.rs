//! Source rollback branches: bootstrap v2, qualified v2, and paused legacy.

use std::{path::Path, sync::Arc};

use serde_json::{Value, json};
use tokio_util::sync::CancellationToken;

use super::super::{
    qualification_witness::{CandidateWitness, LiveWitness},
    rebuild::{assert_live_inventory_matches_candidate, compute_rebuild_readiness},
};
use super::{
    descriptor, error, field, manifest_path, qualification::StoredQualification, read_manifest,
};
use crate::{
    cognition::{
        CognitionPathEnvironment, CognitionResult, MemoryGenerationHandle, MemoryGenerationTarget,
        ensure_data_authority, resolve_generation,
    },
    coordination::{CognitionWaitClass, CognitionWriteAcquire, CognitionWriteCoordinator},
};

pub(crate) async fn rollback(
    data_root: &Path,
    environment: &CognitionPathEnvironment,
    coordinator: Arc<CognitionWriteCoordinator>,
    expected_active: Option<&str>,
    now: &str,
    cancellation: &CancellationToken,
) -> CognitionResult<Value> {
    super::repair_pending(data_root, environment, coordinator.clone(), cancellation).await?;
    let descriptor = descriptor::capture_active_descriptor(data_root, environment)?;
    if expected_active.is_some_and(|expected| descriptor.fields.generation_id != expected) {
        return Err(error("memory_rollback_unavailable"));
    }
    let previous_id = descriptor
        .fields
        .previous_generation_id
        .as_deref()
        .ok_or_else(|| error("memory_rollback_unavailable"))?;
    let path = manifest_path(data_root, environment, previous_id)?;
    let (previous, previous_sha) = read_manifest(&path, previous_id)?;
    let format = field(&previous, "format")?;
    let bootstrap = format == "v2"
        && previous["initialization_origin"] == "empty"
        && previous["schema_version"] == 3
        && matches!(
            previous["extraction_version"].as_str(),
            Some("memory-extract-v2" | "memory-extract-v3")
        )
        && previous["required_acceptance_passed"] == false
        && previous
            .get("acceptance_binding")
            .is_none_or(Value::is_null);
    if !matches!(format, "v2" | "legacy") {
        return Err(error("memory_generation_changed"));
    }
    if format == "v2" && !bootstrap {
        let needs_build = previous["readiness"]["ready"] != true
            || previous["readiness"]["unaccounted"] != 0
            || previous["readiness"]["semantic"]["pending"] != 0
            || previous["readiness"]["semantic"]["failed"] != 0
            || previous["readiness"]["vectors"]["pending"] != 0
            || previous["readiness"]["vectors"]["failed"] != 0
            || previous["readiness"]["cache"]["pending"] != 0
            || previous["readiness"]["cache"]["failed"] != 0
            || !live_inventory_matches(
                data_root,
                environment,
                previous_id,
                &previous,
                cancellation,
            )?;
        if needs_build {
            resume_for_build(
                data_root,
                environment,
                coordinator.clone(),
                &descriptor.raw,
                previous_id,
                cancellation,
            )
            .await?;
            return Ok(
                json!({"rollback_pending":true,"target_generation_id":previous_id,"next_step":"build"}),
            );
        }
        if previous
            .get("acceptance_binding")
            .is_none_or(Value::is_null)
        {
            return Ok(
                json!({"rollback_pending":true,"target_generation_id":previous_id,"next_step":"validate","readiness":previous["readiness"]}),
            );
        }
    }
    let live = LiveWitness::open(data_root)?;
    let mut candidate = None;
    let mut qualification = None;
    if format == "v2" {
        if bootstrap {
            let root = path
                .parent()
                .ok_or_else(|| error("memory_generation_unavailable"))?
                .to_owned();
            let handle = MemoryGenerationHandle {
                generation_id: previous_id.to_owned(),
                graph_path: root.join("graph.sqlite"),
                root,
                embedding: None,
                source_root: data_root.to_owned(),
                canonical_snapshot_path: None,
            };
            let witness = CandidateWitness::open(data_root, &handle).await?;
            witness.assert_current(&handle).await?;
            candidate = Some((handle, witness));
        } else {
            let snapshot_id = field(&previous, "canonical_snapshot_id")?;
            let target = MemoryGenerationTarget::Rebuild {
                generation_id: previous_id.to_owned(),
                canonical_snapshot_id: snapshot_id.to_owned(),
            };
            let handle = resolve_generation(data_root, environment, &target)?;
            let witness = CandidateWitness::open(data_root, &handle).await?;
            assert_live_inventory_matches_candidate(data_root, &handle, cancellation)
                .map_err(|_| error("memory_rollback_requires_catchup"))?;
            let readiness =
                compute_rebuild_readiness(data_root, environment, &target, cancellation).await?;
            if readiness["sha256"] != previous["readiness"]["sha256"] || readiness["ready"] != true
            {
                return Err(error("memory_rollback_requires_catchup"));
            }
            qualification = Some(StoredQualification::open(
                data_root,
                path.parent()
                    .ok_or_else(|| error("memory_generation_unavailable"))?,
                previous_id,
                &previous,
                &readiness,
                "memory_rollback_requires_catchup",
            )?);
            witness.assert_current(&handle).await?;
            candidate = Some((handle, witness));
        }
    }
    live.assert_current()?;
    if let Some(qualification) = &qualification {
        qualification.assert_current()?;
    }
    let lock = environment.consolidation_lock(data_root);
    ensure_data_authority(data_root, &[&lock, &path])?;
    if cancellation.is_cancelled() {
        return Err(error("memory_operation_aborted"));
    }
    let lease = coordinator
        .acquire(
            CognitionWriteAcquire {
                lock_path: lock.clone(),
                purpose: Some("cutover".into()),
                deadline_at_epoch_ms: None,
                cancellation: Some(cancellation.clone()),
            },
            CognitionWaitClass::Background,
        )
        .await
        .map_err(|_| error("memory_write_busy"))?
        .ok_or_else(|| error("memory_write_busy"))?;
    let mut cas_committed = false;
    let result = async {
        lease
            .assert_for_path(&lock)
            .map_err(|_| error("memory_write_busy"))?;
        if cancellation.is_cancelled() {
            return Err(error("memory_operation_aborted"));
        }
        live.assert_current()?;
        if let Some((handle, witness)) = &candidate {
            witness.assert_current(handle).await?;
        }
        if let Some(qualification) = &qualification {
            qualification.assert_file_facts_current()?;
        }
        let (_, current_sha) = read_manifest(&path, previous_id)?;
        if current_sha != previous_sha {
            return Err(error("memory_generation_changed"));
        }
        let next = json!({
            "schema":"butler.memory-active-generation.v2",
            "generation_id":previous_id,
            "previous_generation_id":descriptor.fields.generation_id,
            "activated_at":now,
            "projection_mode":if format == "v2" {"running"} else {"paused"},
        });
        let transitioned = descriptor::commit_descriptor_transition(
            data_root,
            environment,
            &lease,
            &descriptor.raw,
            previous_id,
            &previous_sha,
            next,
        )?;
        cas_committed = true;
        descriptor::reconcile_committed_manifest_states(
            data_root,
            environment,
            &lease,
            &transitioned,
        )?;
        Ok(transitioned)
    }
    .await;
    let released = lease
        .release(cas_committed)
        .map_err(|_| error("memory_write_busy"));
    result.and_then(|descriptor| {
        released?;
        Ok(json!({"descriptor":descriptor,"rollback_pending":format=="v2" && bootstrap,"readiness":if bootstrap {Value::Null} else {previous["readiness"].clone()}}))
    })
}

fn live_inventory_matches(
    data_root: &Path,
    environment: &CognitionPathEnvironment,
    generation_id: &str,
    manifest: &Value,
    cancellation: &CancellationToken,
) -> CognitionResult<bool> {
    let snapshot_id = field(manifest, "canonical_snapshot_id")?;
    let target = MemoryGenerationTarget::Rebuild {
        generation_id: generation_id.to_owned(),
        canonical_snapshot_id: snapshot_id.to_owned(),
    };
    let handle = resolve_generation(data_root, environment, &target)?;
    match assert_live_inventory_matches_candidate(data_root, &handle, cancellation) {
        Ok(()) => Ok(true),
        Err(error) if error.code == "memory_inventory_changed" => Ok(false),
        Err(error) => Err(error),
    }
}

async fn resume_for_build(
    data_root: &Path,
    environment: &CognitionPathEnvironment,
    coordinator: Arc<CognitionWriteCoordinator>,
    expected_descriptor: &Value,
    generation_id: &str,
    cancellation: &CancellationToken,
) -> CognitionResult<()> {
    let path = manifest_path(data_root, environment, generation_id)?;
    let lock = environment.consolidation_lock(data_root);
    ensure_data_authority(data_root, &[&path, &lock])?;
    let lease = coordinator
        .acquire(
            CognitionWriteAcquire {
                lock_path: lock.clone(),
                purpose: Some("rebuild_prepare".into()),
                deadline_at_epoch_ms: None,
                cancellation: Some(cancellation.clone()),
            },
            CognitionWaitClass::Background,
        )
        .await
        .map_err(|_| error("memory_write_busy"))?
        .ok_or_else(|| error("memory_write_busy"))?;
    let result = (|| {
        lease
            .assert_for_path(&lock)
            .map_err(|_| error("memory_write_busy"))?;
        if cancellation.is_cancelled() {
            return Err(error("memory_operation_aborted"));
        }
        let current = descriptor::capture_active_descriptor(data_root, environment)?;
        let current_json =
            crate::json::stringify(&current.raw).map_err(|_| error("memory_generation_changed"))?;
        let expected_json = crate::json::stringify(expected_descriptor)
            .map_err(|_| error("memory_generation_changed"))?;
        if current_json != expected_json
            || current.fields.previous_generation_id.as_deref() != Some(generation_id)
        {
            return Err(error("memory_generation_changed"));
        }
        let (mut manifest, _) = read_manifest(&path, generation_id)?;
        if manifest["format"] != "v2"
            || !matches!(manifest["state"].as_str(), Some("retired" | "building"))
        {
            return Err(error("memory_generation_changed"));
        }
        if manifest["state"] == "retired" {
            manifest["state"] = json!("building");
            super::super::initialize::durable::write_json(&path, &manifest)?;
        }
        Ok(())
    })();
    let released = lease
        .release(result.is_ok())
        .map_err(|_| error("memory_write_busy"));
    result?;
    released
}
