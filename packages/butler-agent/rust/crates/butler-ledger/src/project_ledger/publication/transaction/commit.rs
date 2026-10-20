use crate::project_ledger::publication::timing::fs;
use std::path::Path;

use butler_turn::btcc::ResolvedProjectWorkScope;

use super::claim;
use super::{Journal, JournalStatus, Paths, io, same_logical};
use crate::project_ledger::publication::contracts::{
    ProjectLedgerRecordUpdate, ProjectWorkPublicationError,
};
use crate::project_ledger::publication::occurrence::{self, Attempt, Occurrence};
use crate::project_ledger::publication::record;

/// Writes the journal, takes the canonical claim and builds the candidate:
/// the expected base records copied (plus a before-image), the updates
/// materialized and validated. Any failure removes the candidate and
/// journal and releases the claim.
pub(super) fn prepare(
    scope: &ResolvedProjectWorkScope,
    _occurrence: &Occurrence,
    attempt: &Attempt,
    paths: &Paths,
    updates: &[ProjectLedgerRecordUpdate],
    collation: &butler_core::locale::LocaleCollation,
) -> Result<Journal, ProjectWorkPublicationError> {
    let _phase = crate::project_ledger::publication::timing::Phase::new("publication_prepare");
    let root = &scope.ledger_root;
    let mut journal = Journal {
        schema: "project-ledger.publication-transaction.v1".into(),
        publication_id: attempt.publication_id.clone(),
        canonical_root: root.to_string_lossy().into_owned(),
        candidate_root: paths.candidate.to_string_lossy().into_owned(),
        journal_path: paths.journal.to_string_lossy().into_owned(),
        claim_path: claim::path(root).to_string_lossy().into_owned(),
        base: attempt.expected_base.clone(),
        status: JournalStatus::ClaimPending,
        candidate_head: None,
    };
    occurrence::atomic_json(&paths.journal, &journal)?;
    claim::acquire(
        root,
        &attempt.publication_id,
        &attempt.expected_base.source_sha256,
        &paths.journal,
    )?;
    let result = build_candidate(scope, attempt, paths, updates, collation, &mut journal);
    if result.is_err() {
        let _ = remove_dir(&paths.candidate);
        let _ = remove_dir(&paths.candidate.with_extension("before"));
        let _ = fs::remove_file(&paths.journal);
        let _ = claim::release_if_owned(
            Path::new(&journal.claim_path),
            root,
            &journal.publication_id,
            &journal.base.source_sha256,
        );
    }
    result
}

fn build_candidate(
    scope: &ResolvedProjectWorkScope,
    attempt: &Attempt,
    paths: &Paths,
    updates: &[ProjectLedgerRecordUpdate],
    collation: &butler_core::locale::LocaleCollation,
    journal: &mut Journal,
) -> Result<Journal, ProjectWorkPublicationError> {
    let _phase =
        crate::project_ledger::publication::timing::Phase::new("publication_build_candidate");
    let root = &scope.ledger_root;
    let active = record::observe_expected(root, &attempt.expected_base)?;
    if !same_logical(&active, &attempt.expected_base) {
        return Err(ProjectWorkPublicationError::NotApplied);
    }
    // ClaimPending covers the entire build: it and Preparing have identical
    // recovery behavior, and neither can have changed canonical records.
    let before = paths.candidate.with_extension("before");
    candidate_skeleton(root, &paths.candidate, &before)?;
    copy_base_records(
        root,
        &attempt.expected_base.record_paths,
        &[&paths.candidate, &before],
    )?;
    record::materialize(&paths.candidate, scope, updates)?;
    crate::project_ledger::work::validate_publication_candidate(
        &paths.candidate,
        root,
        scope,
        updates,
        collation,
    )?;
    let candidate_head = record::observe_core_head(
        &paths.candidate,
        &attempt.expected_base,
        &attempt.publication_id,
    )?;
    journal.candidate_head = Some(candidate_head);
    journal.status = JournalStatus::Prepared;
    occurrence::atomic_json(&paths.journal, journal)?;
    Ok(journal.clone())
}

/// A fresh sparse candidate. Only addressed records create Work directories;
/// unrelated Works never enter candidate setup or the v2 head digest.
fn candidate_skeleton(
    root: &Path,
    candidate: &Path,
    before: &Path,
) -> Result<(), ProjectWorkPublicationError> {
    let _phase =
        crate::project_ledger::publication::timing::Phase::new("publication_candidate_skeleton");
    remove_dir(candidate)?;
    remove_dir(before)?;
    fs::create_dir_all(candidate).map_err(|source| io().with_source(source))?;
    fs::copy(root.join("project.json"), candidate.join("project.json"))
        .map_err(|source| io().with_source(source))?;
    fs::write(candidate.join("ledger.jsonl"), "").map_err(|source| io().with_source(source))?;

    Ok(())
}

/// Copies each existing base record into every destination root.
fn copy_base_records(
    root: &Path,
    record_paths: &[String],
    destinations: &[&Path],
) -> Result<(), ProjectWorkPublicationError> {
    let _phase =
        crate::project_ledger::publication::timing::Phase::new("publication_copy_base_records");
    for relative in record_paths {
        let source = record::record_path(root, relative)?;
        let raw = match fs::read(source) {
            Ok(bytes) => bytes,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => continue,
            Err(_) => return Err(io()),
        };
        for base in destinations {
            let destination = record::record_path(base, relative)?;
            fs::create_dir_all(destination.parent().ok_or_else(io)?)
                .map_err(|source| io().with_source(source))?;
            fs::write(destination, &raw).map_err(|source| io().with_source(source))?;
        }
    }
    Ok(())
}

pub(super) fn promote(
    journal: &mut Journal,
    paths: &Paths,
) -> Result<record::ProjectWorkHead, ProjectWorkPublicationError> {
    let _phase = crate::project_ledger::publication::timing::Phase::new("publication_promote");
    let root = Path::new(&journal.canonical_root);
    claim::assert_owned(
        Path::new(&journal.claim_path),
        root,
        &journal.publication_id,
        &journal.base.source_sha256,
    )?;
    let candidate = journal
        .candidate_head
        .as_ref()
        .ok_or(ProjectWorkPublicationError::Uncertain { source: None })?;
    if journal.status == JournalStatus::Prepared {
        let active = record::observe_expected(root, &journal.base)?;
        let prepared =
            record::observe_core_head(&paths.candidate, &journal.base, &journal.publication_id)?;
        if !same_logical(&active, &journal.base)
            || prepared.source_sha256 != candidate.source_sha256
        {
            return Err(ProjectWorkPublicationError::NotApplied);
        }
        journal.status = JournalStatus::Committing;
        occurrence::atomic_json(&paths.journal, journal)?;
    }
    if journal.status == JournalStatus::Committing {
        for relative in &journal.base.record_paths {
            if relative == "project.json" {
                continue;
            }
            let source = record::record_path(&paths.candidate, relative)?;
            let target = record::record_path(root, relative)?;
            let before = record::record_path(&paths.candidate.with_extension("before"), relative)?;
            let raw = read_optional(&source)?;
            let old = read_optional(&before)?;
            if raw == old {
                continue;
            }
            let raw = raw.ok_or(ProjectWorkPublicationError::Uncertain { source: None })?;
            if read_optional(&target)?.as_deref() == Some(raw.as_slice()) {
                continue;
            }
            fs::create_dir_all(target.parent().ok_or_else(io)?)
                .map_err(|source| io().with_source(source))?;
            let temporary = std::path::PathBuf::from(format!("{}.next", source.display()));
            fs::copy(&source, &temporary).map_err(|source| io().with_source(source))?;
            fs::rename(temporary, target).map_err(|source| io().with_source(source))?;
        }
        claim::advance_generation(Path::new(&journal.claim_path), &journal.publication_id)?;
        let active = record::observe_expected(root, &journal.base)?;
        if active.source_sha256 != candidate.source_sha256 {
            return Err(ProjectWorkPublicationError::Uncertain { source: None });
        }
        journal.status = JournalStatus::Promoted;
        occurrence::atomic_json(&paths.journal, journal)?;
        return Ok(active);
    }
    Err(ProjectWorkPublicationError::Uncertain { source: None })
}

fn read_optional(path: &Path) -> Result<Option<Vec<u8>>, ProjectWorkPublicationError> {
    match fs::read(path) {
        Ok(bytes) => Ok(Some(bytes)),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(_) => Err(io()),
    }
}

fn remove_dir(path: &Path) -> Result<(), ProjectWorkPublicationError> {
    match fs::remove_dir_all(path) {
        Ok(()) => Ok(()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(_) => Err(io()),
    }
}
