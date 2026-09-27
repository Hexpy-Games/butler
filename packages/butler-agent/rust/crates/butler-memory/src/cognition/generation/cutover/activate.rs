//! Qualified candidate activation with source witnesses and a short descriptor CAS.
//!
//! Outside the write gate: check the candidate is ready and qualified,
//! recompute its readiness, and revalidate the stored evidence. Under the
//! gate: recheck every witness, swap the descriptor, and settle both manifest
//! states.

use std::{path::Path, sync::Arc};

use tokio_util::sync::CancellationToken;

use super::{
    CutoverStamp, descriptor, error, manifest_path,
    qualification::{QualifiedTarget, StoredQualification},
    read_manifest, required,
};
use crate::{
    cognition::{
        CognitionPathEnvironment, CognitionResult, MemoryGenerationHandle, MemoryGenerationTarget,
        ensure_data_authority, resolve_generation,
    },
    coordination::{CognitionWriteCoordinator, CognitionWriteLease},
};

use super::super::{
    manifest::{
        ActiveDescriptor, GenerationFormat, GenerationManifest, GenerationReadiness,
        GenerationState, ProjectionMode,
    },
    qualification_witness::{CandidateWitness, LiveWitness},
    rebuild::{assert_live_inventory_matches_candidate, compute_rebuild_readiness},
};
use crate::cognition::CognitionCode;

/// Makes a qualified `ready` candidate the serving generation and returns the
/// installed descriptor.
pub async fn activate(
    data_root: &Path,
    environment: &CognitionPathEnvironment,
    coordinator: Arc<CognitionWriteCoordinator>,
    generation_id: &str,
    expected_active: Option<&str>,
    stamp: CutoverStamp<'_>,
    cancellation: &CancellationToken,
) -> CognitionResult<ActiveDescriptor> {
    super::repair_pending(data_root, environment, coordinator.clone(), cancellation).await?;
    if cancellation.is_cancelled() {
        return Err(error(CognitionCode::MemoryOperationAborted));
    }
    let descriptor = descriptor::capture_active_descriptor(data_root, environment)?;
    if expected_active.is_some_and(|expected| descriptor.fields.generation_id != expected)
        || descriptor.fields.generation_id == generation_id
    {
        return Err(error(CognitionCode::MemoryGenerationChanged));
    }
    let path = manifest_path(data_root, environment, generation_id)?;
    let (manifest, manifest_sha) = read_manifest(&path, generation_id)?;
    let stored_readiness = qualified_readiness(&manifest)?;
    let inventory_hash = required(manifest.source_inventory_hash.as_deref())?;
    let target = MemoryGenerationTarget::Rebuild {
        generation_id: generation_id.to_owned(),
        canonical_snapshot_id: required(manifest.canonical_snapshot_id.as_deref())?.to_owned(),
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
    if !readiness.ready
        || !readiness.same_as(stored_readiness)
        || readiness.inventory_hash != inventory_hash
    {
        return Err(error(CognitionCode::ActivationRequiresCatchup));
    }
    let qualification = StoredQualification::open(
        data_root,
        &QualifiedTarget {
            generation_root: path
                .parent()
                .ok_or_else(|| error(CognitionCode::MemoryGenerationUnavailable))?,
            generation_id,
            manifest: &manifest,
            readiness: &readiness,
        },
        CognitionCode::ActivationRequiresCatchup,
        stamp.verified_commit,
    )?;
    qualification.assert_current()?;
    Activation {
        data_root,
        environment,
        path: &path,
        generation_id,
        descriptor: &descriptor,
        manifest_sha: &manifest_sha,
        inventory_hash,
        readiness: &readiness,
        witnesses: (&live, &candidate, &handle),
        qualification: &qualification,
        now: stamp.now,
    }
    .commit(&coordinator, cancellation)
    .await
}

/// The stored readiness of a v2 candidate that is `ready` and still bound to
/// passed qualification.
fn qualified_readiness(manifest: &GenerationManifest) -> CognitionResult<&GenerationReadiness> {
    match &manifest.readiness {
        Some(readiness)
            if manifest.format == Some(GenerationFormat::V2)
                && manifest.state == Some(GenerationState::Ready)
                && manifest.required_acceptance_passed == Some(true)
                && readiness.ready
                && manifest.acceptance_binding.is_some() =>
        {
            Ok(readiness)
        }
        _ => Err(error(CognitionCode::ActivationRequiresCatchup)),
    }
}

/// Everything the leased activation step rechecks before its descriptor CAS.
struct Activation<'a> {
    data_root: &'a Path,
    environment: &'a CognitionPathEnvironment,
    path: &'a Path,
    generation_id: &'a str,
    descriptor: &'a descriptor::DescriptorCapture,
    manifest_sha: &'a str,
    inventory_hash: &'a str,
    readiness: &'a GenerationReadiness,
    witnesses: (
        &'a LiveWitness,
        &'a CandidateWitness,
        &'a MemoryGenerationHandle,
    ),
    qualification: &'a StoredQualification,
    now: &'a str,
}

impl Activation<'_> {
    /// Takes the cutover lease and runs [`Self::run`]; the lease commits once
    /// the descriptor CAS has been written.
    async fn commit(
        &self,
        coordinator: &CognitionWriteCoordinator,
        cancellation: &CancellationToken,
    ) -> CognitionResult<ActiveDescriptor> {
        let lock = self.environment.consolidation_lock(self.data_root);
        ensure_data_authority(self.data_root, &[&lock, self.path])?;
        if cancellation.is_cancelled() {
            return Err(error(CognitionCode::MemoryOperationAborted));
        }
        let lease = crate::cognition::generation::stage::acquire(
            coordinator,
            &lock,
            "cutover",
            cancellation,
        )
        .await?;
        let mut cas_committed = false;
        let result = self
            .run(&lease, &lock, cancellation, &mut cas_committed)
            .await;
        let released = lease
            .release(cas_committed)
            .map_err(|source| error(CognitionCode::MemoryWriteBusy).with_source(source));
        result.and_then(|descriptor| {
            released?;
            Ok(descriptor)
        })
    }

    async fn run(
        &self,
        lease: &CognitionWriteLease,
        lock: &Path,
        cancellation: &CancellationToken,
        cas_committed: &mut bool,
    ) -> CognitionResult<ActiveDescriptor> {
        lease
            .assert_for_path(lock)
            .map_err(|source| error(CognitionCode::MemoryWriteBusy).with_source(source))?;
        if cancellation.is_cancelled() {
            return Err(error(CognitionCode::MemoryOperationAborted));
        }
        let (live, candidate, handle) = self.witnesses;
        candidate.assert_current(handle).await?;
        live.assert_current()?;
        self.qualification.assert_file_facts_current()?;
        let (current_manifest, current_sha) = read_manifest(self.path, self.generation_id)?;
        if current_sha != self.manifest_sha
            || current_manifest.source_inventory_hash.as_deref() != Some(self.inventory_hash)
            || current_manifest
                .readiness
                .as_ref()
                .and_then(|readiness| readiness.sha256.as_deref())
                != self.readiness.sha256.as_deref()
        {
            return Err(error(CognitionCode::ActivationRequiresCatchup));
        }
        let next = descriptor::next_descriptor(
            self.generation_id,
            &self.descriptor.fields.generation_id,
            self.now,
            ProjectionMode::Running,
        );
        let transitioned = descriptor::commit_descriptor_transition(
            self.data_root,
            self.environment,
            lease,
            &descriptor::TransitionGuard {
                expected: self.descriptor,
                target_generation_id: self.generation_id,
                target_manifest_sha256: self.manifest_sha,
            },
            &next,
        )?;
        *cas_committed = true;
        descriptor::reconcile_committed_manifest_states(
            self.data_root,
            self.environment,
            lease,
            &transitioned,
        )?;
        Ok(transitioned.fields)
    }
}
