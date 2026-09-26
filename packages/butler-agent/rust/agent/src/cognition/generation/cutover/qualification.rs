//! Reuse the exact stored v3 evidence and implementation binding at cutover.

use std::path::{Path, PathBuf};

use serde_json::Value;

use super::{error, field};
use crate::cognition::generation::qualification::{
    ValidatedEvidence, assert_evidence_current, assert_evidence_file_facts_current,
    validate_evidence,
};
use crate::cognition::{CognitionResult, ensure_data_authority};

pub(super) struct StoredQualification {
    pub(super) evidence: ValidatedEvidence,
    acceptance: PathBuf,
    evidence_root: PathBuf,
}

impl StoredQualification {
    pub(super) fn open(
        data_root: &Path,
        generation_root: &Path,
        generation_id: &str,
        manifest: &Value,
        readiness: &Value,
        error_code: &'static str,
    ) -> CognitionResult<Self> {
        let binding = manifest
            .get("acceptance_binding")
            .filter(|item| item.is_object())
            .ok_or_else(|| error(error_code))?;
        let qualification_ref = safe_ref(field(binding, "qualification_ref")?)?;
        let root_ref = safe_ref(field(binding, "verification_root_ref")?)?;
        let acceptance = generation_root.join(qualification_ref);
        let evidence_root = generation_root.join(root_ref);
        ensure_data_authority(data_root, &[generation_root, &acceptance, &evidence_root])?;
        let commit = option_env!("BUTLER_MEMORY_VERIFIED_COMMIT")
            .ok_or_else(|| error("memory_acceptance_version_mismatch"))?;
        let extraction = field(manifest, "extraction_version")?;
        let embedding = manifest["embedding"]["version"]
            .as_str()
            .ok_or_else(|| error("memory_acceptance_version_mismatch"))?;
        if binding["target_generation_id"] != generation_id
            || binding["target_source_inventory_hash"] != manifest["source_inventory_hash"]
            || binding["target_readiness_sha256"] != readiness["sha256"]
            || binding["target_evidence_sha256"] != readiness["evidence_sha256"]
            || binding["implementation_commit"] != commit
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
        if binding["qualification_sha256"] != evidence.acceptance_sha256
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
        return Err(error("memory_acceptance_invalid"));
    }
    Ok(path)
}
