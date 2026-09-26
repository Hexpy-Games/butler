use std::fs;
use std::path::Path;

use crate::btcc::ResolvedProjectWorkScope;

use super::claim;
use super::{Journal, JournalStatus, Paths, io, same_logical};
use crate::project_ledger::publication::contracts::{
    ProjectLedgerRecordUpdate, ProjectWorkPublicationError,
};
use crate::project_ledger::publication::occurrence::{self, Attempt, Occurrence};
use crate::project_ledger::publication::record;

pub(super) fn prepare(
    scope: &ResolvedProjectWorkScope,
    _occurrence: &Occurrence,
    attempt: &Attempt,
    paths: &Paths,
    updates: &[ProjectLedgerRecordUpdate],
    collation: &crate::locale::LocaleCollation,
) -> Result<Journal, ProjectWorkPublicationError> {
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
    let result = (|| {
        let active = record::observe_head(root, &attempt.expected_base.record_paths)?;
        if !same_logical(&active, &attempt.expected_base) {
            return Err(ProjectWorkPublicationError::NotApplied);
        }
        journal.status = JournalStatus::Preparing;
        occurrence::atomic_json(&paths.journal, &journal)?;
        remove_dir(&paths.candidate)?;
        let before = paths.candidate.with_extension("before");
        remove_dir(&before)?;
        fs::create_dir_all(&paths.candidate).map_err(|_| io())?;
        fs::copy(
            root.join("project.json"),
            paths.candidate.join("project.json"),
        )
        .map_err(|_| io())?;
        fs::write(paths.candidate.join("ledger.jsonl"), "").map_err(|_| io())?;
        let work_root = root.join("work");
        if work_root.exists() {
            for entry in fs::read_dir(work_root).map_err(|_| io())? {
                let entry = entry.map_err(|_| io())?;
                if entry.file_type().map_err(|_| io())?.is_dir() {
                    fs::create_dir_all(paths.candidate.join("work").join(entry.file_name()))
                        .map_err(|_| io())?;
                }
            }
        }
        for relative in &attempt.expected_base.record_paths {
            let source = record::record_path(root, relative)?;
            let raw = match fs::read(source) {
                Ok(bytes) => bytes,
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => continue,
                Err(_) => return Err(io()),
            };
            for base in [&paths.candidate, &before] {
                let destination = record::record_path(base, relative)?;
                fs::create_dir_all(destination.parent().ok_or_else(io)?).map_err(|_| io())?;
                fs::write(destination, &raw).map_err(|_| io())?;
            }
        }
        record::materialize(&paths.candidate, scope, updates)?;
        crate::project_ledger::work::validate_publication_candidate(
            &paths.candidate,
            root,
            scope,
            updates,
            collation,
        )?;
        let candidate_head =
            record::observe_core_head(&paths.candidate, &attempt.expected_base.record_paths)?;
        journal.candidate_head = Some(candidate_head);
        journal.status = JournalStatus::Prepared;
        occurrence::atomic_json(&paths.journal, &journal)?;
        Ok(journal.clone())
    })();
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

pub(super) fn promote(
    journal: &mut Journal,
    paths: &Paths,
) -> Result<(), ProjectWorkPublicationError> {
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
        .ok_or(ProjectWorkPublicationError::Uncertain)?;
    if journal.status == JournalStatus::Prepared {
        let active = record::observe_head(root, &journal.base.record_paths)?;
        let prepared = record::observe_core_head(&paths.candidate, &journal.base.record_paths)?;
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
            let raw = raw.ok_or(ProjectWorkPublicationError::Uncertain)?;
            if read_optional(&target)?.as_deref() == Some(raw.as_slice()) {
                continue;
            }
            fs::create_dir_all(target.parent().ok_or_else(io)?).map_err(|_| io())?;
            let temporary = std::path::PathBuf::from(format!("{}.next", source.display()));
            fs::copy(&source, &temporary).map_err(|_| io())?;
            fs::rename(temporary, target).map_err(|_| io())?;
        }
        let active = record::observe_head(root, &journal.base.record_paths)?;
        if active.source_sha256 != candidate.source_sha256 {
            return Err(ProjectWorkPublicationError::Uncertain);
        }
        journal.status = JournalStatus::Promoted;
        occurrence::atomic_json(&paths.journal, journal)?;
    }
    Ok(())
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
