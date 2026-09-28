//! Reuse the exact stored v3 evidence and implementation binding at cutover.

use std::path::{Path, PathBuf};

use super::{error, required};
use crate::cognition::CognitionCode;
use crate::cognition::generation::manifest::{GenerationManifest, GenerationReadiness};
use crate::cognition::generation::qualification::{
    ValidatedEvidence, assert_evidence_current, assert_evidence_file_facts_current,
    validate_evidence,
};
use crate::cognition::{CognitionResult, ensure_data_authority};

/// The qualified generation whose stored evidence a cutover reuses.
pub(super) struct QualifiedTarget<'a> {
    pub(super) generation_root: &'a Path,
    pub(super) generation_id: &'a str,
    pub(super) manifest: &'a GenerationManifest,
    /// Freshly computed readiness the binding must still name.
    pub(super) readiness: &'a GenerationReadiness,
}

pub(super) struct StoredQualification {
    pub(super) evidence: ValidatedEvidence,
    acceptance: PathBuf,
    evidence_root: PathBuf,
}

impl StoredQualification {
    /// Revalidates the stored evidence bundle; a binding that no longer names
    /// the target, its readiness, or `verified_commit` fails with `error_code`.
    pub(super) fn open(
        data_root: &Path,
        target: &QualifiedTarget<'_>,
        error_code: CognitionCode,
        verified_commit: Option<&str>,
    ) -> CognitionResult<Self> {
        let manifest = target.manifest;
        let binding = manifest
            .acceptance_binding
            .as_ref()
            .ok_or_else(|| error(error_code))?;
        let acceptance = target
            .generation_root
            .join(safe_ref(&binding.qualification_ref)?);
        let evidence_root = target
            .generation_root
            .join(safe_ref(&binding.verification_root_ref)?);
        ensure_data_authority(
            data_root,
            &[target.generation_root, &acceptance, &evidence_root],
        )?;
        let commit =
            verified_commit.ok_or_else(|| error(CognitionCode::MemoryAcceptanceVersionMismatch))?;
        let extraction = required(manifest.extraction_version.as_deref())?;
        let embedding = manifest
            .embedding_version()
            .ok_or_else(|| error(CognitionCode::MemoryAcceptanceVersionMismatch))?;
        if binding.target_generation_id != target.generation_id
            || manifest.source_inventory_hash.as_deref()
                != Some(binding.target_source_inventory_hash.as_str())
            || target.readiness.sha256.as_deref() != Some(binding.target_readiness_sha256.as_str())
            || binding.target_evidence_sha256 != target.readiness.evidence_sha256
            || binding.implementation_commit != commit
        {
            return Err(error(error_code));
        }
        let evidence = validate_evidence(
            &acceptance,
            &evidence_root,
            Some(commit),
            extraction,
            embedding,
        )?;
        if binding.qualification_sha256 != evidence.acceptance_sha256
            || evidence.implementation_commit != commit
        {
            return Err(error(error_code));
        }
        Ok(Self {
            evidence,
            acceptance,
            evidence_root,
        })
    }

    pub(super) fn assert_current(&self) -> CognitionResult<()> {
        assert_evidence_current(&self.evidence, &self.acceptance, &self.evidence_root)
    }

    pub(super) fn assert_file_facts_current(&self) -> CognitionResult<()> {
        assert_evidence_file_facts_current(&self.evidence, &self.acceptance, &self.evidence_root)
    }
}

fn safe_ref(value: &str) -> CognitionResult<&Path> {
    let path = Path::new(value);
    if value.is_empty()
        || path.is_absolute()
        || path
            .components()
            .any(|part| !matches!(part, std::path::Component::Normal(_)))
    {
        return Err(error(CognitionCode::MemoryAcceptanceInvalid));
    }
    Ok(path)
}
