//! Source rollback branches: bootstrap v2, qualified v2, and paused legacy.
//!
//! A qualified v2 predecessor that no longer matches its sources is first
//! resumed for a rebuild ([`RollbackStep::Build`]) or sent back to validation
//! ([`RollbackStep::Validate`]); otherwise the descriptor swaps back to it.

use std::{path::Path, sync::Arc};

use serde::Serialize;
use tokio_util::sync::CancellationToken;

use super::super::{
    manifest::{
        ActiveDescriptor, GenerationFormat, GenerationManifest, GenerationReadiness,
        GenerationState, InitializationOrigin, ProjectionMode,
    },
    qualification_witness::{CandidateWitness, LiveWitness},
    rebuild::{assert_live_inventory_matches_candidate, compute_rebuild_readiness},
};
use super::{
    CutoverStamp, descriptor, error, manifest_path,
    qualification::{QualifiedTarget, StoredQualification},
    read_manifest, required,
};
use crate::cognition::CognitionCode;
use crate::{
    cognition::{
        CognitionPathEnvironment, CognitionResult, MemoryGenerationHandle, MemoryGenerationTarget,
        ensure_data_authority, resolve_generation,
    },
    coordination::{CognitionWriteCoordinator, CognitionWriteLease},
};

/// What the operator must do before a pending rollback can commit.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum RollbackStep {
    /// Rebuild the resumed predecessor.
    Build,
    /// Requalify the predecessor.
    Validate,
}

/// Result of one rollback attempt.
#[derive(Clone, Debug, Serialize)]
#[serde(untagged)]
pub enum RollbackOutcome {
    /// The predecessor needs work first; nothing was swapped.
    Pending {
        /// Always `true`.
        rollback_pending: bool,
        /// The predecessor generation.
        target_generation_id: String,
        /// The required next command.
        next_step: RollbackStep,
        /// Stored readiness, reported when validation is next.
        #[serde(skip_serializing_if = "Option::is_none")]
        readiness: Option<GenerationReadiness>,
    },
    /// The descriptor now serves the predecessor.
    Committed {
        /// The installed descriptor.
        descriptor: ActiveDescriptor,
        /// True when a bootstrap generation still needs serving catch-up.
        rollback_pending: bool,
        /// The predecessor's stored readiness (`null` for bootstrap and legacy).
        readiness: Option<GenerationReadiness>,
    },
}

impl RollbackOutcome {
    fn pending(
        target_generation_id: &str,
        next_step: RollbackStep,
        readiness: Option<GenerationReadiness>,
    ) -> Self {
        Self::Pending {
            rollback_pending: true,
            target_generation_id: target_generation_id.to_owned(),
            next_step,
            readiness,
        }
    }
}

/// Which kind of predecessor the rollback returns to.
#[derive(Clone, Copy, PartialEq, Eq)]
enum Predecessor {
    /// The empty-root v2 generation, never qualified.
    Bootstrap,
    /// A qualified v2 rebuild.
    Qualified,
    /// The adopted legacy baseline.
    Legacy,
}

impl Predecessor {
    fn of(manifest: &GenerationManifest) -> CognitionResult<Self> {
        match manifest.format {
            Some(GenerationFormat::Legacy) => Ok(Self::Legacy),
            Some(GenerationFormat::V2) if is_bootstrap(manifest) => Ok(Self::Bootstrap),
            Some(GenerationFormat::V2) => Ok(Self::Qualified),
            None => Err(error(CognitionCode::MemoryGenerationChanged)),
        }
    }
}

fn is_bootstrap(manifest: &GenerationManifest) -> bool {
    manifest.initialization_origin == Some(InitializationOrigin::Empty)
        && manifest.schema_version == Some(3)
        && matches!(
            manifest.extraction_version.as_deref(),
            Some("memory-extract-v2" | "memory-extract-v3")
        )
        && manifest.required_acceptance_passed == Some(false)
        && manifest.acceptance_binding.is_none()
}

/// Swaps the descriptor back to the previous generation, or reports what the
/// predecessor needs first.
pub async fn rollback(
    data_root: &Path,
    environment: &CognitionPathEnvironment,
    coordinator: Arc<CognitionWriteCoordinator>,
    expected_active: Option<&str>,
    stamp: CutoverStamp<'_>,
    cancellation: &CancellationToken,
) -> CognitionResult<RollbackOutcome> {
    super::repair_pending(data_root, environment, coordinator.clone(), cancellation).await?;
    let descriptor = descriptor::capture_active_descriptor(data_root, environment)?;
    if expected_active.is_some_and(|expected| descriptor.fields.generation_id != expected) {
        return Err(error(CognitionCode::MemoryRollbackUnavailable));
    }
    let previous_id = descriptor
        .fields
        .previous_generation_id
        .clone()
        .ok_or_else(|| error(CognitionCode::MemoryRollbackUnavailable))?;
    let path = manifest_path(data_root, environment, &previous_id)?;
    let (previous, previous_sha) = read_manifest(&path, &previous_id)?;
    let kind = Predecessor::of(&previous)?;
    if kind == Predecessor::Qualified
        && let Some(pending) = qualified_pending_step(
            data_root,
            environment,
            &coordinator,
            (&descriptor, &previous_id, &previous),
            cancellation,
        )
        .await?
    {
        return Ok(pending);
    }
    let live = LiveWitness::open(data_root)?;
    let (candidate, qualification) = match kind {
        Predecessor::Bootstrap => (
            Some(bootstrap_witness(data_root, &path, &previous_id).await?),
            None,
        ),
        Predecessor::Qualified => {
            let (candidate, qualification) = qualified_witness(
                data_root,
                environment,
                (&path, &previous_id, &previous),
                stamp.verified_commit,
                cancellation,
            )
            .await?;
            (Some(candidate), Some(qualification))
        }
        Predecessor::Legacy => (None, None),
    };
    live.assert_current()?;
    if let Some(qualification) = &qualification {
        qualification.assert_current()?;
    }
    let installed = Swap {
        data_root,
        environment,
        path: &path,
        previous_id: &previous_id,
        previous_sha: &previous_sha,
        descriptor: &descriptor,
        live: &live,
        candidate: candidate.as_ref(),
        qualification: qualification.as_ref(),
        projection_mode: previous
            .format
            .map_or(ProjectionMode::Paused, ProjectionMode::for_format),
        now: stamp.now,
    }
    .commit(&coordinator, cancellation)
    .await?;
    let bootstrap = kind == Predecessor::Bootstrap;
    Ok(RollbackOutcome::Committed {
        descriptor: installed,
        rollback_pending: bootstrap,
        readiness: if bootstrap { None } else { previous.readiness },
    })
}

/// A qualified predecessor whose readiness is unsettled or whose sources
/// changed is resumed for a rebuild; one without a binding needs validation.
async fn qualified_pending_step(
    data_root: &Path,
    environment: &CognitionPathEnvironment,
    coordinator: &Arc<CognitionWriteCoordinator>,
    (descriptor, previous_id, previous): (
        &descriptor::DescriptorCapture,
        &str,
        &GenerationManifest,
    ),
    cancellation: &CancellationToken,
) -> CognitionResult<Option<RollbackOutcome>> {
    let settled = previous
        .readiness
        .as_ref()
        .is_some_and(GenerationReadiness::settled);
    if !settled
        || !live_inventory_matches(data_root, environment, previous_id, previous, cancellation)?
    {
        resume_for_build(
            data_root,
            environment,
            coordinator.clone(),
            descriptor,
            previous_id,
            cancellation,
        )
        .await?;
        return Ok(Some(RollbackOutcome::pending(
            previous_id,
            RollbackStep::Build,
            None,
        )));
    }
    if previous.acceptance_binding.is_none() {
        return Ok(Some(RollbackOutcome::pending(
            previous_id,
            RollbackStep::Validate,
            previous.readiness.clone(),
        )));
    }
    Ok(None)
}

/// The bootstrap generation serves live sources directly; witness its files.
async fn bootstrap_witness(
    data_root: &Path,
    path: &Path,
    previous_id: &str,
) -> CognitionResult<(MemoryGenerationHandle, CandidateWitness)> {
    let root = path
        .parent()
        .ok_or_else(|| error(CognitionCode::MemoryGenerationUnavailable))?
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
    Ok((handle, witness))
}

/// A qualified predecessor must still be ready against live sources, with
/// its stored evidence intact.
async fn qualified_witness(
    data_root: &Path,
    environment: &CognitionPathEnvironment,
    (path, previous_id, previous): (&Path, &str, &GenerationManifest),
    verified_commit: Option<&str>,
    cancellation: &CancellationToken,
) -> CognitionResult<(
    (MemoryGenerationHandle, CandidateWitness),
    StoredQualification,
)> {
    let target = MemoryGenerationTarget::Rebuild {
        generation_id: previous_id.to_owned(),
        canonical_snapshot_id: required(previous.canonical_snapshot_id.as_deref())?.to_owned(),
    };
    let handle = resolve_generation(data_root, environment, &target)?;
    let witness = CandidateWitness::open(data_root, &handle).await?;
    assert_live_inventory_matches_candidate(data_root, &handle, cancellation).map_err(
        |source| error(CognitionCode::MemoryRollbackRequiresCatchup).with_source(source),
    )?;
    let readiness =
        compute_rebuild_readiness(data_root, environment, &target, cancellation).await?;
    let stored_sha = previous
        .readiness
        .as_ref()
        .and_then(|stored| stored.sha256.as_deref());
    if readiness.sha256.as_deref() != stored_sha || !readiness.ready {
        return Err(error(CognitionCode::MemoryRollbackRequiresCatchup));
    }
    let qualification = StoredQualification::open(
        data_root,
        &QualifiedTarget {
            generation_root: path
                .parent()
                .ok_or_else(|| error(CognitionCode::MemoryGenerationUnavailable))?,
            generation_id: previous_id,
            manifest: previous,
            readiness: &readiness,
        },
        CognitionCode::MemoryRollbackRequiresCatchup,
        verified_commit,
    )?;
    witness.assert_current(&handle).await?;
    Ok(((handle, witness), qualification))
}

/// Everything the leased rollback step rechecks before its descriptor CAS.
struct Swap<'a> {
    data_root: &'a Path,
    environment: &'a CognitionPathEnvironment,
    path: &'a Path,
    previous_id: &'a str,
    previous_sha: &'a str,
    descriptor: &'a descriptor::DescriptorCapture,
    live: &'a LiveWitness,
    candidate: Option<&'a (MemoryGenerationHandle, CandidateWitness)>,
    qualification: Option<&'a StoredQualification>,
    projection_mode: ProjectionMode,
    now: &'a str,
}

impl Swap<'_> {
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
        self.live.assert_current()?;
        if let Some((handle, witness)) = self.candidate {
            witness.assert_current(handle).await?;
        }
        if let Some(qualification) = self.qualification {
            qualification.assert_file_facts_current()?;
        }
        let (_, current_sha) = read_manifest(self.path, self.previous_id)?;
        if current_sha != self.previous_sha {
            return Err(error(CognitionCode::MemoryGenerationChanged));
        }
        let next = descriptor::next_descriptor(
            self.previous_id,
            &self.descriptor.fields.generation_id,
            self.now,
            self.projection_mode,
        );
        let transitioned = descriptor::commit_descriptor_transition(
            self.data_root,
            self.environment,
            lease,
            &descriptor::TransitionGuard {
                expected: self.descriptor,
                target_generation_id: self.previous_id,
                target_manifest_sha256: self.previous_sha,
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

fn live_inventory_matches(
    data_root: &Path,
    environment: &CognitionPathEnvironment,
    generation_id: &str,
    manifest: &GenerationManifest,
    cancellation: &CancellationToken,
) -> CognitionResult<bool> {
    let target = MemoryGenerationTarget::Rebuild {
        generation_id: generation_id.to_owned(),
        canonical_snapshot_id: required(manifest.canonical_snapshot_id.as_deref())?.to_owned(),
    };
    let handle = resolve_generation(data_root, environment, &target)?;
    match assert_live_inventory_matches_candidate(data_root, &handle, cancellation) {
        Ok(()) => Ok(true),
        Err(error) if error.code() == "memory_inventory_changed" => Ok(false),
        Err(error) => Err(error),
    }
}

/// Moves a retired predecessor back to `building` so it can be rebuilt.
async fn resume_for_build(
    data_root: &Path,
    environment: &CognitionPathEnvironment,
    coordinator: Arc<CognitionWriteCoordinator>,
    expected_descriptor: &descriptor::DescriptorCapture,
    generation_id: &str,
    cancellation: &CancellationToken,
) -> CognitionResult<()> {
    let path = manifest_path(data_root, environment, generation_id)?;
    let lock = environment.consolidation_lock(data_root);
    ensure_data_authority(data_root, &[&path, &lock])?;
    let lease = crate::cognition::generation::stage::acquire(
        &coordinator,
        &lock,
        "rebuild_prepare",
        cancellation,
    )
    .await?;
    let data_root = data_root.to_owned();
    let environment = environment.to_owned();
    let expected = expected_descriptor.stringified.clone();
    let generation_id = generation_id.to_owned();
    let cancellation = cancellation.to_owned();
    crate::cognition::generation::stage::leased(
        lease,
        CognitionCode::MemoryGenerationUnavailable,
        move |lease| {
            lease
                .assert_for_path(&lock)
                .map_err(|source| error(CognitionCode::MemoryWriteBusy).with_source(source))?;
            if cancellation.is_cancelled() {
                return Err(error(CognitionCode::MemoryOperationAborted));
            }
            let current = descriptor::capture_active_descriptor(&data_root, &environment)?;
            if current.stringified != expected
                || current.fields.previous_generation_id.as_deref() != Some(generation_id.as_str())
            {
                return Err(error(CognitionCode::MemoryGenerationChanged));
            }
            let (mut manifest, _) = read_manifest(&path, &generation_id)?;
            if manifest.format != Some(GenerationFormat::V2)
                || !matches!(
                    manifest.state,
                    Some(GenerationState::Retired | GenerationState::Building)
                )
            {
                return Err(error(CognitionCode::MemoryGenerationChanged));
            }
            if manifest.state == Some(GenerationState::Retired) {
                manifest.state = Some(GenerationState::Building);
                super::super::initialize::durable::write_json(&path, &manifest)?;
            }
            Ok(())
        },
    )
    .await
}
