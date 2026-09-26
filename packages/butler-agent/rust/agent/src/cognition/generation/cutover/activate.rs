//! Qualified candidate activation with source witnesses and a short descriptor CAS.

use std::{path::Path, sync::Arc};

use serde_json::{Value, json};
use tokio_util::sync::CancellationToken;

use super::{
    descriptor, error, field, manifest_path, qualification::StoredQualification, read_manifest,
};
use crate::{
    cognition::{
        CognitionPathEnvironment, CognitionResult, MemoryGenerationTarget, ensure_data_authority,
        resolve_generation,
    },
    coordination::{CognitionWaitClass, CognitionWriteAcquire, CognitionWriteCoordinator},
};

use super::super::{
    qualification_witness::{CandidateWitness, LiveWitness},
    rebuild::{assert_live_inventory_matches_candidate, compute_rebuild_readiness},
};

pub(crate) async fn activate(
    data_root: &Path,
    environment: &CognitionPathEnvironment,
    coordinator: Arc<CognitionWriteCoordinator>,
    generation_id: &str,
    expected_active: Option<&str>,
    now: &str,
    cancellation: &CancellationToken,
) -> CognitionResult<Value> {
    super::repair_pending(data_root, environment, coordinator.clone(), cancellation).await?;
    if cancellation.is_cancelled() {
        return Err(error("memory_operation_aborted"));
    }
    let descriptor = descriptor::capture_active_descriptor(data_root, environment)?;
    if expected_active.is_some_and(|expected| descriptor.fields.generation_id != expected)
        || descriptor.fields.generation_id == generation_id
    {
        return Err(error("memory_generation_changed"));
    }
    let path = manifest_path(data_root, environment, generation_id)?;
    let (manifest, manifest_sha) = read_manifest(&path, generation_id)?;
    let binding = manifest.get("acceptance_binding");
    let stored_readiness = &manifest["readiness"];
    if manifest["format"] != "v2"
        || manifest["state"] != "ready"
        || manifest["required_acceptance_passed"] != true
        || stored_readiness["ready"] != true
        || binding.is_none_or(Value::is_null)
    {
        return Err(error("activation_requires_catchup"));
    }
    let inventory_hash = field(&manifest, "source_inventory_hash")?;
    let snapshot_id = field(&manifest, "canonical_snapshot_id")?;
    let target = MemoryGenerationTarget::Rebuild {
        generation_id: generation_id.to_owned(),
        canonical_snapshot_id: snapshot_id.to_owned(),
    };
    let handle = resolve_generation(data_root, environment, &target)?;
    let live = LiveWitness::open(data_root)?;
    assert_live_inventory_matches_candidate(data_root, &handle, cancellation)?;
    live.assert_current()?;
    let candidate = CandidateWitness::open(data_root, &handle).await?;
    let readiness =
        compute_rebuild_readiness(data_root, environment, &target, cancellation).await?;
    candidate.assert_current(&handle).await?;
    live.assert_current()?;
    if readiness["ready"] != true
        || readiness["sha256"] != stored_readiness["sha256"]
        || readiness["evidence_sha256"] != stored_readiness["evidence_sha256"]
        || readiness["inventory_hash"] != inventory_hash
    {
        return Err(error("activation_requires_catchup"));
    }
    let qualification = StoredQualification::open(
        data_root,
        path.parent()
            .ok_or_else(|| error("memory_generation_unavailable"))?,
        generation_id,
        &manifest,
        &readiness,
        "activation_requires_catchup",
    )?;
    qualification.assert_current()?;
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
        candidate.assert_current(&handle).await?;
        live.assert_current()?;
        qualification.assert_file_facts_current()?;
        let (current_manifest, current_sha) = read_manifest(&path, generation_id)?;
        if current_sha != manifest_sha
            || current_manifest["source_inventory_hash"] != inventory_hash
            || current_manifest["readiness"]["sha256"] != readiness["sha256"]
        {
            return Err(error("activation_requires_catchup"));
        }
        let next = json!({
            "schema":"butler.memory-active-generation.v2",
            "generation_id":generation_id,
            "previous_generation_id":descriptor.fields.generation_id,
            "activated_at":now,
            "projection_mode":"running",
        });
        let transitioned = descriptor::commit_descriptor_transition(
            data_root,
            environment,
            &lease,
            &descriptor.raw,
            generation_id,
            &manifest_sha,
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
    result.and_then(|value| {
        released?;
        Ok(value)
    })
}
