//! Rebuild qualification: verify without a write gate, then commit one bound result.
//!
//! [`validate`] checks the candidate is ready, validates the acceptance
//! evidence, stages a copy of the bundle, and recomputes readiness. Only then
//! does it take the write gate to swap the bundle into `qualification/` and
//! mark the manifest `ready` with an [`AcceptanceBinding`].

use crate::cognition::CognitionCode;
use std::{
    fs::{self, File, OpenOptions},
    io::{Read, Write},
    path::{Path, PathBuf},
    sync::Arc,
};

use sha2::{Digest, Sha256};
use tokio_util::sync::CancellationToken;

use super::{
    MemoryGenerationHandle, MemoryGenerationTarget,
    initialize::durable,
    manifest::{AcceptanceBinding, GenerationManifest, GenerationReadiness, GenerationState},
    qualification::{
        CapturedEvidenceRef, ValidatedEvidence, assert_evidence_current,
        assert_evidence_file_facts_current, validate_evidence,
    },
    qualification_witness::{CandidateWitness, LiveWitness},
};
use crate::{
    cognition::{
        CognitionError, CognitionPathEnvironment, CognitionResult, compute_rebuild_readiness,
        ensure_data_authority, resolve_generation,
    },
    coordination::{CognitionWriteCoordinator, CognitionWriteLease},
};

struct StagedBundle(Option<PathBuf>);

impl Drop for StagedBundle {
    fn drop(&mut self) {
        if let Some(path) = &self.0 {
            let _ = fs::remove_dir_all(path);
        }
    }
}

/// Paths of the candidate being qualified.
struct Candidate {
    generation_id: String,
    root: PathBuf,
    manifest_path: PathBuf,
    lock: PathBuf,
    target: MemoryGenerationTarget,
    handle: MemoryGenerationHandle,
}

/// Versions the evidence must match, taken from the manifest before any work.
struct BoundVersions {
    inventory_hash: String,
    extraction_version: String,
    embedding_version: String,
}

impl BoundVersions {
    fn of(manifest: &GenerationManifest) -> CognitionResult<Self> {
        Ok(Self {
            inventory_hash: required(manifest.source_inventory_hash.as_deref())?.to_owned(),
            extraction_version: required(manifest.extraction_version.as_deref())?.to_owned(),
            embedding_version: manifest
                .embedding_version()
                .ok_or_else(|| error(CognitionCode::MemoryAcceptanceVersionMismatch))?
                .to_owned(),
        })
    }
}

/// Qualifies a building candidate against the acceptance bundle at
/// `acceptance_path` and returns the `ready` manifest.
pub async fn validate(
    data_root: &Path,
    environment: &CognitionPathEnvironment,
    coordinator: Arc<CognitionWriteCoordinator>,
    generation_id: &str,
    acceptance_path: &Path,
    cancellation: &CancellationToken,
    verified_implementation_commit: Option<&str>,
) -> CognitionResult<GenerationManifest> {
    if cancellation.is_cancelled() {
        return Err(error(CognitionCode::MemoryOperationAborted));
    }
    let (candidate, manifest) = open_candidate(data_root, environment, generation_id)?;
    let live = LiveWitness::open(data_root)?;
    super::rebuild::assert_live_inventory_matches_candidate(
        data_root,
        &candidate.handle,
        cancellation,
    )?;
    live.assert_current()?;
    let witness = CandidateWitness::open(data_root, &candidate.handle).await?;
    let readiness =
        compute_rebuild_readiness(data_root, environment, &candidate.target, cancellation).await?;
    witness.assert_current(&candidate.handle).await?;
    live.assert_current()?;
    if !readiness.ready {
        return Err(error(CognitionCode::MemoryGenerationNotReady));
    }
    let versions = BoundVersions::of(&manifest)?;
    let evidence =
        validate_acceptance(acceptance_path, &versions, verified_implementation_commit).await?;
    if cancellation.is_cancelled() {
        return Err(error(CognitionCode::MemoryOperationAborted));
    }
    let evidence_root = acceptance_root(acceptance_path)?;
    let mut staged = stage(data_root, &candidate, acceptance_path, &evidence).await?;
    assert_evidence_current(&evidence, acceptance_path, &evidence_root)?;
    witness.assert_current(&candidate.handle).await?;
    live.assert_current()?;
    assert_readiness_unchanged(data_root, environment, &candidate, &readiness, cancellation)
        .await?;
    witness.assert_current(&candidate.handle).await?;
    live.assert_current()?;
    if cancellation.is_cancelled() {
        return Err(error(CognitionCode::MemoryOperationAborted));
    }
    let lease = crate::cognition::generation::stage::acquire(
        &coordinator,
        &candidate.lock,
        "rebuild_validate",
        cancellation,
    )
    .await?;
    let commit = Commit {
        data_root,
        candidate: &candidate,
        versions: &versions,
        readiness: &readiness,
        evidence: &evidence,
        acceptance_path,
        evidence_root: &evidence_root,
        witnesses: (&live, &witness),
    };
    let result = commit.run(&lease, cancellation, &mut staged).await;
    let released = lease
        .release(result.is_ok())
        .map_err(|source| error(CognitionCode::MemoryWriteBusy).with_source(source));
    let (manifest, old) = result?;
    if let Some(old) = old {
        let _ = fs::remove_dir_all(old);
    }
    released?;
    Ok(manifest)
}

/// Staging took time; the candidate must still have exactly the readiness
/// the evidence was validated against.
async fn assert_readiness_unchanged(
    data_root: &Path,
    environment: &CognitionPathEnvironment,
    candidate: &Candidate,
    readiness: &GenerationReadiness,
    cancellation: &CancellationToken,
) -> CognitionResult<()> {
    let fresh =
        compute_rebuild_readiness(data_root, environment, &candidate.target, cancellation).await?;
    if !fresh.same_as(readiness) {
        return Err(error(CognitionCode::MemoryGenerationNotReady));
    }
    Ok(())
}

fn open_candidate(
    data_root: &Path,
    environment: &CognitionPathEnvironment,
    generation_id: &str,
) -> CognitionResult<(Candidate, GenerationManifest)> {
    if generation_id.len() != 36
        || !generation_id
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte) || byte == b'-')
    {
        return Err(error(CognitionCode::MemoryGenerationVersionUnsupported));
    }
    let memory_root = environment.memory_root(data_root);
    let root = memory_root.join("generations").join(generation_id);
    let manifest_path = root.join("manifest.json");
    let lock = environment.consolidation_lock(data_root);
    ensure_data_authority(data_root, &[&memory_root, &root, &manifest_path, &lock])?;
    let manifest =
        GenerationManifest::read(&manifest_path, CognitionCode::MemoryGenerationUnavailable)?;
    let target = MemoryGenerationTarget::Rebuild {
        generation_id: generation_id.to_owned(),
        canonical_snapshot_id: required(manifest.canonical_snapshot_id.as_deref())?.to_owned(),
    };
    let handle = resolve_generation(data_root, environment, &target)?;
    Ok((
        Candidate {
            generation_id: generation_id.to_owned(),
            root,
            manifest_path,
            lock,
            target,
            handle,
        },
        manifest,
    ))
}

fn acceptance_root(acceptance_path: &Path) -> CognitionResult<PathBuf> {
    acceptance_path
        .parent()
        .map(Path::to_owned)
        .ok_or_else(|| error(CognitionCode::MemoryAcceptanceInvalid))
}

/// Validates the acceptance bundle on the blocking pool.
async fn validate_acceptance(
    acceptance_path: &Path,
    versions: &BoundVersions,
    verified_implementation_commit: Option<&str>,
) -> CognitionResult<ValidatedEvidence> {
    let evidence_root = acceptance_root(acceptance_path)?;
    let acceptance_path = acceptance_path.to_owned();
    let commit = verified_implementation_commit.map(str::to_owned);
    let extraction = versions.extraction_version.clone();
    let embedding = versions.embedding_version.clone();
    let evidence = tokio::task::spawn_blocking(move || {
        validate_evidence(
            &acceptance_path,
            &evidence_root,
            commit.as_deref(),
            &extraction,
            &embedding,
        )
    })
    .await
    .map_err(|source| {
        error(CognitionCode::MemoryAcceptanceEvidenceInvalid).with_source(source)
    })??;
    if verified_implementation_commit != Some(evidence.implementation_commit.as_str()) {
        return Err(error(CognitionCode::MemoryAcceptanceVersionMismatch));
    }
    Ok(evidence)
}

/// Copies the validated bundle into a staging directory of the candidate.
async fn stage(
    data_root: &Path,
    candidate: &Candidate,
    acceptance_path: &Path,
    evidence: &ValidatedEvidence,
) -> CognitionResult<StagedBundle> {
    let staged_path = candidate
        .root
        .join(format!(".qualification-{}", uuid::Uuid::new_v4()));
    ensure_data_authority(data_root, &[&staged_path])?;
    let (stage_data, stage_input, stage_target, stage_files) = (
        data_root.to_owned(),
        acceptance_path.to_owned(),
        staged_path.clone(),
        evidence.files.clone(),
    );
    let staged = StagedBundle(Some(staged_path));
    tokio::task::spawn_blocking(move || {
        stage_bundle(&stage_data, &stage_input, &stage_target, &stage_files)
    })
    .await
    .map_err(|source| error(CognitionCode::MemoryQualificationIoError).with_source(source))??;
    Ok(staged)
}

/// The leased qualification commit.
struct Commit<'a> {
    data_root: &'a Path,
    candidate: &'a Candidate,
    versions: &'a BoundVersions,
    readiness: &'a GenerationReadiness,
    evidence: &'a ValidatedEvidence,
    acceptance_path: &'a Path,
    evidence_root: &'a Path,
    witnesses: (&'a LiveWitness, &'a CandidateWitness),
}

impl Commit<'_> {
    /// Rechecks every witness, swaps the staged bundle into `qualification/`,
    /// and writes the `ready` manifest. Returns the manifest and the replaced
    /// bundle to delete after the gate is released.
    async fn run(
        &self,
        lease: &CognitionWriteLease,
        cancellation: &CancellationToken,
        staged: &mut StagedBundle,
    ) -> CognitionResult<(GenerationManifest, Option<PathBuf>)> {
        let candidate = self.candidate;
        lease
            .assert_for_path(&candidate.lock)
            .map_err(|source| error(CognitionCode::MemoryWriteBusy).with_source(source))?;
        if cancellation.is_cancelled() {
            return Err(error(CognitionCode::MemoryOperationAborted));
        }
        let (live, witness) = self.witnesses;
        witness.assert_current(&candidate.handle).await?;
        live.assert_current()?;
        assert_evidence_file_facts_current(
            self.evidence,
            self.acceptance_path,
            self.evidence_root,
        )?;
        let mut current = GenerationManifest::read(
            &candidate.manifest_path,
            CognitionCode::MemoryGenerationUnavailable,
        )?;
        if current.source_inventory_hash.as_deref() != Some(self.versions.inventory_hash.as_str())
            || current.extraction_version.as_deref()
                != Some(self.versions.extraction_version.as_str())
            || current.embedding_version() != Some(self.versions.embedding_version.as_str())
        {
            return Err(error(CognitionCode::MemoryGenerationChanged));
        }
        let old = self.install_bundle(staged)?;
        qualify_manifest(
            &mut current,
            self.readiness,
            self.evidence,
            &candidate.generation_id,
            &self.versions.inventory_hash,
        );
        // The helper may fail after replacing the manifest but before its
        // directory sync. Keep the complete evidence bundle in either case;
        // removing it could leave a ready manifest with a broken binding.
        durable::write_json(&candidate.manifest_path, &current)?;
        Ok((current, old))
    }

    /// Renames the staged bundle to `qualification/`, keeping any prior bundle
    /// aside until the swap is durable.
    fn install_bundle(&self, staged: &mut StagedBundle) -> CognitionResult<Option<PathBuf>> {
        let root = &self.candidate.root;
        let staged_path = staged
            .0
            .clone()
            .ok_or_else(|| error(CognitionCode::MemoryQualificationIoError))?;
        let qualification = root.join("qualification");
        let old = root.join(format!(".qualification-old-{}", uuid::Uuid::new_v4()));
        ensure_data_authority(
            self.data_root,
            &[
                &qualification,
                &old,
                &staged_path,
                &self.candidate.manifest_path,
            ],
        )?;
        let had_prior = qualification.exists();
        if had_prior {
            fs::rename(&qualification, &old).map_err(|source| {
                error(CognitionCode::MemoryQualificationIoError).with_source(source)
            })?;
        }
        if fs::rename(&staged_path, &qualification).is_err() {
            if had_prior {
                let _ = fs::rename(&old, &qualification);
            }
            return Err(error(CognitionCode::MemoryQualificationIoError));
        }
        staged.0 = None;
        if butler_platform::secure_fs::sync_path(root).is_err() {
            let _ = fs::rename(&qualification, &staged_path);
            staged.0 = Some(staged_path);
            if had_prior {
                let _ = fs::rename(&old, &qualification);
            }
            return Err(error(CognitionCode::MemoryQualificationIoError));
        }
        Ok(had_prior.then_some(old))
    }
}

/// Marks a building manifest ready and binds it to the validated evidence and
/// the readiness it was qualified against.
pub(super) fn qualify_manifest(
    current: &mut GenerationManifest,
    readiness: &GenerationReadiness,
    evidence: &ValidatedEvidence,
    generation_id: &str,
    inventory_hash: &str,
) {
    current.state = Some(GenerationState::Ready);
    current.record_readiness(readiness);
    current.required_acceptance_passed = Some(true);
    current.acceptance_binding = Some(AcceptanceBinding {
        qualification_sha256: evidence.acceptance_sha256.clone(),
        qualification_ref: "qualification/acceptance.json".into(),
        verification_root_ref: "qualification/evidence".into(),
        implementation_commit: evidence.implementation_commit.clone(),
        verification_generation_id: evidence.verification_generation_id.clone(),
        target_generation_id: generation_id.to_owned(),
        target_source_inventory_hash: inventory_hash.to_owned(),
        target_readiness_sha256: readiness.sha256.clone().unwrap_or_default(),
        target_evidence_sha256: readiness.evidence_sha256.clone(),
    });
}

fn stage_bundle(
    data_root: &Path,
    acceptance_path: &Path,
    stage: &Path,
    files: &[CapturedEvidenceRef],
) -> CognitionResult<()> {
    durable::create_dir(stage)?;
    let verification_root = acceptance_path
        .parent()
        .ok_or_else(|| error(CognitionCode::MemoryAcceptanceInvalid))?;
    for expected in files {
        let (source, target) = if expected.relative_ref == "acceptance" {
            (acceptance_path.to_owned(), stage.join("acceptance.json"))
        } else {
            (
                verification_root.join(&expected.relative_ref),
                stage.join("evidence").join(&expected.relative_ref),
            )
        };
        ensure_data_authority(data_root, &[stage, &target])?;
        let parent = target
            .parent()
            .ok_or_else(|| error(CognitionCode::MemoryQualificationIoError))?;
        durable::create_dir(parent)?;
        copy_checked(&source, &target, &expected.sha256)?;
    }
    butler_platform::secure_fs::sync_path(stage)
        .map_err(|source| error(CognitionCode::MemoryQualificationIoError).with_source(source))?;
    Ok(())
}

fn copy_checked(source: &Path, target: &Path, expected_sha: &str) -> CognitionResult<()> {
    let mut source = File::open(source).map_err(|source| {
        error(CognitionCode::MemoryAcceptanceEvidenceChanged).with_source(source)
    })?;
    let mut options = OpenOptions::new();
    options.write(true).create_new(true);
    butler_platform::secure_fs::owner_only(&mut options);
    let mut target = options
        .open(target)
        .map_err(|source| error(CognitionCode::MemoryQualificationIoError).with_source(source))?;
    let mut hasher = Sha256::new();
    let mut buffer = vec![0_u8; 64 * 1024];
    loop {
        let count = source.read(&mut buffer).map_err(|source| {
            error(CognitionCode::MemoryAcceptanceEvidenceChanged).with_source(source)
        })?;
        let Some(chunk) = buffer.get(..count).filter(|chunk| !chunk.is_empty()) else {
            break;
        };
        hasher.update(chunk);
        target.write_all(chunk).map_err(|source| {
            error(CognitionCode::MemoryQualificationIoError).with_source(source)
        })?;
    }
    if format!("{:x}", hasher.finalize()) != expected_sha {
        return Err(error(CognitionCode::MemoryAcceptanceEvidenceChanged));
    }
    target
        .sync_all()
        .map_err(|source| error(CognitionCode::MemoryQualificationIoError).with_source(source))?;
    Ok(())
}

/// A manifest fact qualification requires.
fn required(value: Option<&str>) -> CognitionResult<&str> {
    value.ok_or_else(|| error(CognitionCode::MemoryGenerationChanged))
}

fn error(code: CognitionCode) -> CognitionError {
    CognitionError::new(code, code.as_str())
}
