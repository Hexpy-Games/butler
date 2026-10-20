//! Sparse, journaled canonical publication and receipt reconciliation.

pub(in crate::project_ledger::publication) mod claim;
mod commit;
#[cfg(test)]
pub(super) mod tests;

use crate::project_ledger::publication::timing::fs;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

use butler_turn::btcc::ResolvedProjectWorkScope;

use super::contracts::{ProjectLedgerRecordUpdate, ProjectWorkPublicationError, ProjectWorkTarget};
use super::occurrence::{self, Attempt, Occurrence};
use super::record::{self, ProjectWorkHead};

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
enum JournalStatus {
    ClaimPending,
    Preparing,
    Prepared,
    Committing,
    Promoted,
    Observed,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
#[serde(deny_unknown_fields)]
struct Journal {
    schema: String,
    publication_id: String,
    canonical_root: String,
    candidate_root: String,
    journal_path: String,
    claim_path: String,
    base: ProjectWorkHead,
    status: JournalStatus,
    #[serde(skip_serializing_if = "Option::is_none")]
    candidate_head: Option<ProjectWorkHead>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
enum ReceiptStatus {
    Observed,
    NotApplied,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
#[serde(deny_unknown_fields)]
struct Receipt {
    schema: String,
    occurrence_id: String,
    attempt_number: usize,
    request_sha256: String,
    publication_id: String,
    status: ReceiptStatus,
    base_head: ProjectWorkHead,
    #[serde(skip_serializing_if = "Option::is_none")]
    candidate_head: Option<ProjectWorkHead>,
}

struct Paths {
    candidate: PathBuf,
    journal: PathBuf,
    receipt: PathBuf,
}

pub(super) enum Reconciled {
    Applied(Vec<ProjectWorkTarget>),
    Ready,
    NotAppliedWithReceipt,
    NotApplied,
}

pub(super) fn reconcile(
    data_root: &Path,
    occurrence: &Occurrence,
) -> Result<Reconciled, ProjectWorkPublicationError> {
    let _phase = crate::project_ledger::publication::timing::Phase::new("publication_reconcile");
    let attempt = latest(occurrence)?;
    let paths = paths(data_root, attempt);
    if let Some(receipt) = read_receipt(&paths, occurrence, attempt)? {
        if receipt.status == ReceiptStatus::Observed {
            if let Some(journal) = read_journal(&paths, occurrence, attempt)? {
                cleanup(&journal, &paths)?;
            }
            return Ok(Reconciled::Applied(attempt.target_preconditions.clone()));
        }
        return Ok(Reconciled::NotAppliedWithReceipt);
    }
    let Some(journal) = read_journal(&paths, occurrence, attempt)? else {
        if fs::exists(&paths.candidate)
            || fs::exists(claim::path(Path::new(&occurrence.ledger_root)))
        {
            return Err(ProjectWorkPublicationError::Uncertain { source: None });
        }
        write_receipt(&paths, occurrence, attempt, ReceiptStatus::NotApplied, None)?;
        return Ok(Reconciled::NotApplied);
    };
    match journal.status {
        JournalStatus::ClaimPending | JournalStatus::Preparing => {
            cleanup(&journal, &paths)?;
            write_receipt(&paths, occurrence, attempt, ReceiptStatus::NotApplied, None)?;
            Ok(Reconciled::NotApplied)
        }
        JournalStatus::Prepared => {
            if same_logical(
                &record::observe_expected(Path::new(&occurrence.ledger_root), &journal.base)?,
                &journal.base,
            ) {
                Ok(Reconciled::Ready)
            } else {
                cleanup(&journal, &paths)?;
                write_receipt(&paths, occurrence, attempt, ReceiptStatus::NotApplied, None)?;
                Ok(Reconciled::NotApplied)
            }
        }
        JournalStatus::Committing => Ok(Reconciled::Ready),
        JournalStatus::Promoted | JournalStatus::Observed => {
            let candidate = journal
                .candidate_head
                .as_ref()
                .ok_or(ProjectWorkPublicationError::Uncertain { source: None })?;
            let active =
                record::observe_expected(Path::new(&occurrence.ledger_root), &journal.base)?;
            if !same_head(&active, candidate) {
                return Err(ProjectWorkPublicationError::Uncertain { source: None });
            }
            write_receipt(
                &paths,
                occurrence,
                attempt,
                ReceiptStatus::Observed,
                Some(candidate.clone()),
            )?;
            cleanup(&journal, &paths)?;
            Ok(Reconciled::Applied(attempt.target_preconditions.clone()))
        }
    }
}

pub(super) fn apply(
    data_root: &Path,
    scope: &ResolvedProjectWorkScope,
    occurrence: &Occurrence,
    updates: Option<&[ProjectLedgerRecordUpdate]>,
    collation: &butler_core::locale::LocaleCollation,
) -> Result<Vec<ProjectWorkTarget>, ProjectWorkPublicationError> {
    let _phase = crate::project_ledger::publication::timing::Phase::new("publication_apply");
    let attempt = latest(occurrence)?;
    let paths = paths(data_root, attempt);
    let existing = read_journal(&paths, occurrence, attempt)?;
    let resuming_commit = existing
        .as_ref()
        .is_some_and(|j| j.status == JournalStatus::Committing);
    if !resuming_commit {
        for target in &attempt.target_preconditions {
            record::revalidate_target(scope, target)?;
        }
        let active = record::observe_expected(&scope.ledger_root, &attempt.expected_base)?;
        if !same_logical(&active, &attempt.expected_base) {
            write_receipt(&paths, occurrence, attempt, ReceiptStatus::NotApplied, None)?;
            return Err(ProjectWorkPublicationError::NotApplied);
        }
    }
    let result = (|| {
        let mut journal = if let Some(journal) = existing {
            if !matches!(
                journal.status,
                JournalStatus::Prepared | JournalStatus::Committing
            ) {
                return Err(ProjectWorkPublicationError::Uncertain { source: None });
            }
            journal
        } else {
            let updates = updates.ok_or(ProjectWorkPublicationError::Uncertain { source: None })?;
            commit::prepare(scope, occurrence, attempt, &paths, updates, collation)?
        };
        let active = commit::promote(&mut journal, &paths)?;
        let candidate = journal
            .candidate_head
            .clone()
            .ok_or(ProjectWorkPublicationError::Uncertain { source: None })?;
        if !same_head(&active, &candidate) {
            return Err(ProjectWorkPublicationError::Uncertain { source: None });
        }
        // Promoted already records the verified head. The receipt is the
        // durable observation; another journal rewrite adds no recovery state.
        write_receipt(
            &paths,
            occurrence,
            attempt,
            ReceiptStatus::Observed,
            Some(candidate),
        )?;
        cleanup(&journal, &paths)?;
        Ok(attempt.target_preconditions.clone())
    })();
    match result {
        Ok(targets) => Ok(targets),
        Err(_) => match reconcile(data_root, occurrence)? {
            Reconciled::Applied(targets) => Ok(targets),
            Reconciled::Ready => Err(ProjectWorkPublicationError::Uncertain { source: None }),
            Reconciled::NotApplied | Reconciled::NotAppliedWithReceipt => {
                Err(ProjectWorkPublicationError::NotApplied)
            }
        },
    }
}

fn latest(occurrence: &Occurrence) -> Result<&Attempt, ProjectWorkPublicationError> {
    occurrence
        .attempts
        .last()
        .ok_or(ProjectWorkPublicationError::Uncertain { source: None })
}

fn paths(root: &Path, attempt: &Attempt) -> Paths {
    let root = root.join("runtime/btcc-project-ledger-effects-v2");
    Paths {
        candidate: root.join("candidates").join(&attempt.publication_id),
        journal: root
            .join("journals")
            .join(format!("{}.json", attempt.publication_id)),
        receipt: root
            .join("receipts")
            .join(format!("{}.json", attempt.publication_id)),
    }
}

fn read_receipt(
    paths: &Paths,
    occurrence: &Occurrence,
    attempt: &Attempt,
) -> Result<Option<Receipt>, ProjectWorkPublicationError> {
    let Some(receipt): Option<Receipt> = read_json(&paths.receipt)? else {
        return Ok(None);
    };
    if receipt.schema != "butler.btcc-project-ledger-publication-receipt.v1"
        || receipt.occurrence_id != occurrence.occurrence_id
        || receipt.attempt_number != attempt.number
        || receipt.request_sha256 != attempt.request_sha256
        || receipt.publication_id != attempt.publication_id
        || !matches!(
            receipt.base_head.schema.as_str(),
            "butler.btcc-project-ledger-head.v1" | "butler.btcc-project-ledger-head.v2"
        )
        || receipt.base_head.storage_authority.is_some()
        || receipt.base_head.project_root != occurrence.ledger_root
        || receipt.base_head.record_paths != attempt.expected_base.record_paths
        || receipt.base_head.schema != attempt.expected_base.schema
        || !same_head(&receipt.base_head, &attempt.expected_base)
        || (receipt.status == ReceiptStatus::Observed) != receipt.candidate_head.is_some()
        || receipt.candidate_head.as_ref().is_some_and(|head| {
            head.schema != receipt.base_head.schema
                || head.project_root != occurrence.ledger_root
                || head.record_paths != attempt.expected_base.record_paths
                || head.storage_authority.is_some()
        })
    {
        return Err(ProjectWorkPublicationError::Uncertain { source: None });
    }
    Ok(Some(receipt))
}

fn read_journal(
    paths: &Paths,
    occurrence: &Occurrence,
    attempt: &Attempt,
) -> Result<Option<Journal>, ProjectWorkPublicationError> {
    let _phase = crate::project_ledger::publication::timing::Phase::new("publication_read_journal");
    let Some(journal): Option<Journal> = read_json(&paths.journal)? else {
        return Ok(None);
    };
    if journal.schema != "project-ledger.publication-transaction.v1"
        || journal.publication_id != attempt.publication_id
        || journal.canonical_root != occurrence.ledger_root
        || Path::new(&journal.candidate_root) != paths.candidate
        || Path::new(&journal.journal_path) != paths.journal
        || Path::new(&journal.claim_path) != claim::path(Path::new(&occurrence.ledger_root))
        || journal.base.schema != attempt.expected_base.schema
        || !same_head(&journal.base, &attempt.expected_base)
        || !matches!(
            journal.base.schema.as_str(),
            "butler.btcc-project-ledger-head.v1" | "butler.btcc-project-ledger-head.v2"
        )
        || journal.base.storage_authority.is_some()
        || journal.base.project_root != occurrence.ledger_root
        || journal.base.record_paths != attempt.expected_base.record_paths
        || matches!(
            journal.status,
            JournalStatus::Prepared
                | JournalStatus::Committing
                | JournalStatus::Promoted
                | JournalStatus::Observed
        ) != journal.candidate_head.is_some()
        || journal.candidate_head.as_ref().is_some_and(|head| {
            head.schema
                != if journal.base.schema.ends_with(".v1") {
                    "project-ledger.source-head.v1"
                } else {
                    "project-ledger.source-head.v2"
                }
                || head.project_root != journal.candidate_root
                || head.record_paths != attempt.expected_base.record_paths
                || head.storage_authority.as_deref() != Some("project-ledger-record-set-v1")
        })
    {
        return Err(ProjectWorkPublicationError::Uncertain { source: None });
    }
    Ok(Some(journal))
}

fn read_json<T: for<'de> Deserialize<'de>>(
    path: &Path,
) -> Result<Option<T>, ProjectWorkPublicationError> {
    match fs::read(path) {
        Ok(bytes) => serde_json::from_slice(&bytes).map(Some).map_err(|source| {
            ProjectWorkPublicationError::Uncertain { source: None }.with_source(source)
        }),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(_) => Err(ProjectWorkPublicationError::io(
            "project_ledger_publication_io_error",
        )),
    }
}

fn write_receipt(
    paths: &Paths,
    occurrence: &Occurrence,
    attempt: &Attempt,
    status: ReceiptStatus,
    candidate_head: Option<ProjectWorkHead>,
) -> Result<(), ProjectWorkPublicationError> {
    let _phase =
        crate::project_ledger::publication::timing::Phase::new("publication_write_receipt");
    let candidate_head = candidate_head.map(|mut head| {
        head.schema.clone_from(&attempt.expected_base.schema);
        head.project_root.clone_from(&occurrence.ledger_root);
        head.storage_authority = None;
        head
    });
    occurrence::atomic_json(
        &paths.receipt,
        &Receipt {
            schema: "butler.btcc-project-ledger-publication-receipt.v1".into(),
            occurrence_id: occurrence.occurrence_id.clone(),
            attempt_number: attempt.number,
            request_sha256: attempt.request_sha256.clone(),
            publication_id: attempt.publication_id.clone(),
            status,
            base_head: attempt.expected_base.clone(),
            candidate_head,
        },
    )
}

fn cleanup(journal: &Journal, paths: &Paths) -> Result<(), ProjectWorkPublicationError> {
    let _phase = crate::project_ledger::publication::timing::Phase::new("publication_cleanup");
    claim::release_if_owned(
        Path::new(&journal.claim_path),
        Path::new(&journal.canonical_root),
        &journal.publication_id,
        &journal.base.source_sha256,
    )?;
    fs::remove_dir_all(&paths.candidate)
        .or_else(ignore_missing)
        .map_err(|source| io().with_source(source))?;
    fs::remove_dir_all(paths.candidate.with_extension("before"))
        .or_else(ignore_missing)
        .map_err(|source| io().with_source(source))?;
    if matches!(
        journal.status,
        JournalStatus::ClaimPending | JournalStatus::Preparing | JournalStatus::Prepared
    ) {
        fs::remove_file(&paths.journal)
            .or_else(ignore_missing)
            .map_err(|source| io().with_source(source))?;
    }
    Ok(())
}

fn ignore_missing(error: std::io::Error) -> Result<(), std::io::Error> {
    if error.kind() == std::io::ErrorKind::NotFound {
        Ok(())
    } else {
        Err(error)
    }
}

fn same_head(left: &ProjectWorkHead, right: &ProjectWorkHead) -> bool {
    left.source_sha256 == right.source_sha256
        && left.source_file_count == right.source_file_count
        && left.storage_sha256 == right.storage_sha256
        && left.storage_entry_count == right.storage_entry_count
}

fn same_logical(left: &ProjectWorkHead, right: &ProjectWorkHead) -> bool {
    left.project_root == right.project_root
        && left.source_sha256 == right.source_sha256
        && left.source_file_count == right.source_file_count
}

fn io() -> ProjectWorkPublicationError {
    ProjectWorkPublicationError::io("project_ledger_publication_io_error")
}
