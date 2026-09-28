//! Qualification of a rebuild candidate: acceptance evidence recorded before cutover.

mod case;
mod io;
mod performance;
mod source;
mod types;

use crate::cognition::CognitionCode;
use std::path::Path;

use crate::cognition::{CognitionError, CognitionResult};
use io::{CaptureStore, valid_git_commit, valid_sha};
use performance::validate_performance;

pub(super) use io::{
    CapturedEvidenceRef, assert_evidence_current, assert_evidence_file_facts_current,
};

/// Facts accepted from a source-preserving v3 qualification bundle.
#[derive(Debug)]
pub(super) struct ValidatedEvidence {
    pub acceptance_sha256: String,
    pub verification_generation_id: String,
    pub implementation_commit: String,
    pub files: Vec<CapturedEvidenceRef>,
}

pub(super) fn validate_evidence(
    acceptance_path: &Path,
    evidence_root: &Path,
    expected_implementation_commit: Option<&str>,
    expected_extraction_version: &str,
    expected_embedding_version: &str,
) -> CognitionResult<ValidatedEvidence> {
    if !valid_sha(expected_embedding_version)
        || !matches!(
            expected_extraction_version,
            "memory-extract-v2" | "memory-extract-v3"
        )
    {
        return Err(invalid(CognitionCode::MemoryAcceptanceVersionMismatch));
    }

    let mut capture = CaptureStore::new(acceptance_path, evidence_root)?;
    let (acceptance, acceptance_sha256) = capture.read_acceptance::<types::Acceptance>()?;
    validate_acceptance_header(
        &acceptance,
        expected_extraction_version,
        expected_embedding_version,
    )?;

    let mut case_ids = std::collections::HashSet::new();
    let mut covered = std::collections::HashSet::new();
    for item in &acceptance.cases {
        if !case_ids.insert(item.id.as_str()) {
            return Err(invalid(CognitionCode::MemoryAcceptanceEvidenceInvalid));
        }
        case::validate_case(item, &acceptance, &mut capture)?;
        covered.extend(item.mr_ids.iter().map(String::as_str));
    }
    for index in 1..=12 {
        let id = format!("MR-{index:02}");
        if !covered.contains(id.as_str()) {
            return Err(invalid(CognitionCode::MemoryAcceptanceIncomplete));
        }
    }
    if !acceptance.cases.iter().any(|item| {
        item.path == "public_app_btcc"
            && item.uses_real_extractor
            && item.mr_ids.iter().any(|id| id == "MR-03")
    }) || !acceptance.cases.iter().any(|item| {
        item.path == "public_app_btcc"
            && item.uses_real_extractor
            && item.mr_ids.iter().any(|id| id == "MR-05")
    }) || !acceptance
        .cases
        .iter()
        .any(|item| item.path == "native_tool" && item.mr_ids.iter().any(|id| id == "MR-09"))
        || !acceptance
            .cases
            .iter()
            .any(|item| item.uses_real_embedding && item.mr_ids.iter().any(|id| id == "MR-08"))
        || !acceptance.cases.iter().any(|item| {
            item.path == "owner_integration" && item.mr_ids.iter().any(|id| id == "MR-12")
        })
    {
        return Err(invalid(CognitionCode::MemoryAcceptanceIncomplete));
    }

    validate_performance(&acceptance, &mut capture)?;
    if expected_implementation_commit.is_some_and(|expected| {
        !valid_git_commit(expected) || expected != acceptance.implementation_commit
    }) {
        return Err(invalid(CognitionCode::MemoryAcceptanceVersionMismatch));
    }
    Ok(ValidatedEvidence {
        acceptance_sha256,
        verification_generation_id: acceptance.verification_generation_id,
        implementation_commit: acceptance.implementation_commit,
        files: capture.into_files(),
    })
}

fn validate_acceptance_header(
    value: &types::Acceptance,
    expected_extraction_version: &str,
    expected_embedding_version: &str,
) -> CognitionResult<()> {
    if value.schema != "butler.memory-recovery-acceptance.v3"
        || value.tool_contract_version != 2
        || !valid_sha(&value.verification_source_inventory_hash)
        || !valid_git_commit(&value.implementation_commit)
        || value.extraction_version != expected_extraction_version
        || !valid_sha(&value.embedding_version)
        || value.embedding_version != expected_embedding_version
    {
        return Err(invalid(CognitionCode::MemoryAcceptanceVersionMismatch));
    }
    if value.verification_generation_id.is_empty() || value.cases.is_empty() {
        return Err(invalid(CognitionCode::MemoryAcceptanceInvalid));
    }
    Ok(())
}

pub(super) fn invalid(code: CognitionCode) -> CognitionError {
    CognitionError::new(
        code,
        "source-preserving memory qualification evidence did not validate",
    )
}

#[cfg(test)]
pub(crate) mod tests;
