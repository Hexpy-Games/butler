//! Rebuild qualification: verify without a write gate, then commit one bound result.

use crate::cognition::CognitionCode;
use std::{
    fs::{self, File, OpenOptions},
    io::{Read, Write},
    path::{Path, PathBuf},
    sync::Arc,
};

use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use tokio_util::sync::CancellationToken;

use super::{
    MemoryGenerationTarget,
    initialize::durable,
    qualification::{
        assert_evidence_current, assert_evidence_file_facts_current, validate_evidence,
    },
    qualification_witness::{CandidateWitness, LiveWitness},
};
use crate::{
    cognition::{
        CognitionError, CognitionPathEnvironment, CognitionResult, compute_rebuild_readiness,
        ensure_data_authority, resolve_generation,
    },
    coordination::{CognitionWaitClass, CognitionWriteAcquire, CognitionWriteCoordinator},
};

struct StagedBundle(Option<PathBuf>);

impl Drop for StagedBundle {
    fn drop(&mut self) {
        if let Some(path) = &self.0 {
            let _ = fs::remove_dir_all(path);
        }
    }
}

pub(crate) async fn validate(
    data_root: &Path,
    environment: &CognitionPathEnvironment,
    coordinator: Arc<CognitionWriteCoordinator>,
    generation_id: &str,
    acceptance_path: &Path,
    cancellation: &CancellationToken,
    verified_implementation_commit: Option<&str>,
) -> CognitionResult<Value> {
    if cancellation.is_cancelled() {
        return Err(error(CognitionCode::MemoryOperationAborted));
    }
    if generation_id.len() != 36
        || !generation_id
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte) || byte == b'-')
    {
        return Err(error(CognitionCode::MemoryGenerationVersionUnsupported));
    }
    let memory_root = environment.memory_root(data_root);
    let generation_root = memory_root.join("generations").join(generation_id);
    let manifest_path = generation_root.join("manifest.json");
    let lock = environment.consolidation_lock(data_root);
    ensure_data_authority(
        data_root,
        &[&memory_root, &generation_root, &manifest_path, &lock],
    )?;
    let manifest = read_manifest(&manifest_path)?;
    let snapshot_id = field(&manifest, "canonical_snapshot_id")?;
    let target = MemoryGenerationTarget::Rebuild {
        generation_id: generation_id.to_owned(),
        canonical_snapshot_id: snapshot_id.to_owned(),
    };
    let handle = resolve_generation(data_root, environment, &target)?;
    let live = LiveWitness::open(data_root)?;
    super::rebuild::assert_live_inventory_matches_candidate(data_root, &handle, cancellation)?;
    live.assert_current()?;
    let candidate = CandidateWitness::open(data_root, &handle).await?;
    let readiness =
        compute_rebuild_readiness(data_root, environment, &target, cancellation).await?;
    candidate.assert_current(&handle).await?;
    live.assert_current()?;
    if readiness["ready"] != true {
        return Err(error(CognitionCode::MemoryGenerationNotReady));
    }
    let inventory_hash = field(&manifest, "source_inventory_hash")?;
    let extraction_version = field(&manifest, "extraction_version")?;
    let embedding_version = manifest["embedding"]["version"]
        .as_str()
        .ok_or_else(|| error(CognitionCode::MemoryAcceptanceVersionMismatch))?;
    let acceptance_path = acceptance_path.to_owned();
    let evidence_root = acceptance_path
        .parent()
        .ok_or_else(|| error(CognitionCode::MemoryAcceptanceInvalid))?
        .to_owned();
    let validation_path = acceptance_path.clone();
    let validation_root = evidence_root.clone();
    let commit_owned = verified_implementation_commit.map(str::to_owned);
    let extraction_owned = extraction_version.to_owned();
    let embedding_owned = embedding_version.to_owned();
    let evidence = tokio::task::spawn_blocking(move || {
        validate_evidence(
            &validation_path,
            &validation_root,
            commit_owned.as_deref(),
            &extraction_owned,
            &embedding_owned,
        )
    })
    .await
    .map_err(|source| {
        error(CognitionCode::MemoryAcceptanceEvidenceInvalid).with_source(source)
    })??;
    if verified_implementation_commit != Some(evidence.implementation_commit.as_str()) {
        return Err(error(CognitionCode::MemoryAcceptanceVersionMismatch));
    }
    if cancellation.is_cancelled() {
        return Err(error(CognitionCode::MemoryOperationAborted));
    }
    let staged_path = generation_root.join(format!(".qualification-{}", uuid::Uuid::new_v4()));
    ensure_data_authority(data_root, &[&staged_path])?;
    let stage_data = data_root.to_owned();
    let stage_input = acceptance_path.clone();
    let stage_target = staged_path.clone();
    let stage_files = evidence.files.clone();
    let mut staged = StagedBundle(Some(staged_path.clone()));
    tokio::task::spawn_blocking(move || {
        stage_bundle(&stage_data, &stage_input, &stage_target, &stage_files)
    })
    .await
    .map_err(|source| error(CognitionCode::MemoryQualificationIoError).with_source(source))??;
    assert_evidence_current(&evidence, &acceptance_path, &evidence_root)?;
    candidate.assert_current(&handle).await?;
    live.assert_current()?;
    let fresh = compute_rebuild_readiness(data_root, environment, &target, cancellation).await?;
    if fresh["sha256"] != readiness["sha256"]
        || fresh["evidence_sha256"] != readiness["evidence_sha256"]
    {
        return Err(error(CognitionCode::MemoryGenerationNotReady));
    }
    candidate.assert_current(&handle).await?;
    live.assert_current()?;
    if cancellation.is_cancelled() {
        return Err(error(CognitionCode::MemoryOperationAborted));
    }
    let lease = coordinator
        .acquire(
            CognitionWriteAcquire {
                lock_path: lock.clone(),
                purpose: Some("rebuild_validate".into()),
                deadline_at_epoch_ms: None,
                cancellation: Some(cancellation.clone()),
            },
            CognitionWaitClass::Background,
        )
        .await
        .map_err(|source| error(CognitionCode::MemoryWriteBusy).with_source(source))?
        .ok_or_else(|| error(CognitionCode::MemoryWriteBusy))?;
    let result = async {
        lease
            .assert_for_path(&lock)
            .map_err(|source| error(CognitionCode::MemoryWriteBusy).with_source(source))?;
        if cancellation.is_cancelled() {
            return Err(error(CognitionCode::MemoryOperationAborted));
        }
        candidate.assert_current(&handle).await?;
        live.assert_current()?;
        assert_evidence_file_facts_current(&evidence, &acceptance_path, &evidence_root)?;
        let mut current = read_manifest(&manifest_path)?;
        if current["source_inventory_hash"] != inventory_hash
            || current["extraction_version"] != extraction_version
            || current["embedding"]["version"] != embedding_version
        {
            return Err(error(CognitionCode::MemoryGenerationChanged));
        }
        let qualification = generation_root.join("qualification");
        let old = generation_root.join(format!(".qualification-old-{}", uuid::Uuid::new_v4()));
        ensure_data_authority(
            data_root,
            &[&qualification, &old, &staged_path, &manifest_path],
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
        if File::open(&generation_root)
            .and_then(|dir| dir.sync_all())
            .is_err()
        {
            let _ = fs::rename(&qualification, &staged_path);
            staged.0 = Some(staged_path.clone());
            if had_prior {
                let _ = fs::rename(&old, &qualification);
            }
            return Err(error(CognitionCode::MemoryQualificationIoError));
        }
        current["state"] = json!("ready");
        current["registered_source_count"] = readiness["registered"].clone();
        current["unaccounted_source_count"] = readiness["unaccounted"].clone();
        current["required_acceptance_passed"] = json!(true);
        current["readiness"] = readiness.clone();
        current["acceptance_binding"] = json!({
            "qualification_sha256":evidence.acceptance_sha256,
            "qualification_ref":"qualification/acceptance.json",
            "verification_root_ref":"qualification/evidence",
            "implementation_commit":evidence.implementation_commit,
            "verification_generation_id":evidence.verification_generation_id,
            "target_generation_id":generation_id,
            "target_source_inventory_hash":inventory_hash,
            "target_readiness_sha256":readiness["sha256"],
            "target_evidence_sha256":readiness["evidence_sha256"],
        });
        // The helper may fail after replacing the manifest but before its
        // directory sync. Keep the complete evidence bundle in either case;
        // removing it could leave a ready manifest with a broken binding.
        durable::write_json(&manifest_path, &current)?;
        Ok((current, had_prior.then_some(old)))
    }
    .await;
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

fn stage_bundle(
    data_root: &Path,
    acceptance_path: &Path,
    stage: &Path,
    files: &[super::qualification::CapturedEvidenceRef],
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
    File::open(stage)
        .and_then(|dir| dir.sync_all())
        .map_err(|source| error(CognitionCode::MemoryQualificationIoError).with_source(source))?;
    Ok(())
}

fn copy_checked(source: &Path, target: &Path, expected_sha: &str) -> CognitionResult<()> {
    let mut source = File::open(source).map_err(|source| {
        error(CognitionCode::MemoryAcceptanceEvidenceChanged).with_source(source)
    })?;
    let mut options = OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    let mut target = options
        .open(target)
        .map_err(|source| error(CognitionCode::MemoryQualificationIoError).with_source(source))?;
    let mut hasher = Sha256::new();
    let mut buffer = vec![0_u8; 64 * 1024];
    loop {
        let count = source.read(&mut buffer).map_err(|source| {
            error(CognitionCode::MemoryAcceptanceEvidenceChanged).with_source(source)
        })?;
        if count == 0 {
            break;
        }
        hasher.update(&buffer[..count]);
        target.write_all(&buffer[..count]).map_err(|source| {
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

fn read_manifest(path: &Path) -> CognitionResult<Value> {
    serde_json::from_slice(
        &fs::read(path).map_err(|source| {
            error(CognitionCode::MemoryGenerationUnavailable).with_source(source)
        })?,
    )
    .map_err(|source| error(CognitionCode::MemoryGenerationUnavailable).with_source(source))
}

fn field<'a>(value: &'a Value, name: &str) -> CognitionResult<&'a str> {
    value[name]
        .as_str()
        .ok_or_else(|| error(CognitionCode::MemoryGenerationChanged))
}

fn error(code: CognitionCode) -> CognitionError {
    CognitionError::new(code, code.as_str())
}
