use std::fs;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

use super::commit;
use super::contracts::LedgerEffectError;
use super::head::{self, LedgerHead};
use super::occurrence::{Attempt, Occurrence};
use crate::locale::LocaleCollation;
use crate::project_ledger::publication::occurrence as shared;
use crate::project_ledger::publication::transaction::claim;

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub(super) enum Status {
    ClaimPending,
    Preparing,
    Prepared,
    Committing,
    Promoted,
    Observed,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(super) struct Journal {
    pub schema: String,
    pub publication_id: String,
    pub canonical_root: String,
    pub candidate_root: String,
    pub journal_path: String,
    pub claim_path: String,
    pub base: LedgerHead,
    pub status: Status,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub candidate_head: Option<LedgerHead>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
enum ReceiptStatus {
    Observed,
    NotApplied,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Receipt {
    schema: String,
    occurrence_id: String,
    attempt_number: usize,
    request_sha256: String,
    publication_id: String,
    status: ReceiptStatus,
    base_head: LedgerHead,
    #[serde(skip_serializing_if = "Option::is_none")]
    candidate_head: Option<LedgerHead>,
}

pub(super) struct Paths {
    pub candidate: PathBuf,
    pub journal: PathBuf,
    pub receipt: PathBuf,
}

pub(super) struct Applied {
    pub publication_id: String,
    pub base: LedgerHead,
}

pub(super) enum Reconciled {
    Applied(Applied),
    Ready,
    NotAppliedWithReceipt,
    NotApplied,
}

pub(super) fn paths(data_root: &Path, attempt: &Attempt) -> Paths {
    let root = data_root.join("runtime/btcc-project-ledger-effects-v2");
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

pub(super) fn new_journal(root: &Path, attempt: &Attempt, paths: &Paths) -> Journal {
    Journal {
        schema: "project-ledger.publication-transaction.v1".into(),
        publication_id: attempt.publication_id.clone(),
        canonical_root: root.to_string_lossy().into_owned(),
        candidate_root: paths.candidate.to_string_lossy().into_owned(),
        journal_path: paths.journal.to_string_lossy().into_owned(),
        claim_path: claim::path(root).to_string_lossy().into_owned(),
        base: attempt.expected_base.clone(),
        status: Status::ClaimPending,
        candidate_head: None,
    }
}

pub(super) fn save_journal(paths: &Paths, journal: &Journal) -> Result<(), LedgerEffectError> {
    shared::atomic_json(&paths.journal, journal).map_err(|_| LedgerEffectError::Uncertain)
}

pub(super) fn read_journal(
    paths: &Paths,
    occurrence: &Occurrence,
    attempt: &Attempt,
) -> Result<Option<Journal>, LedgerEffectError> {
    let Some(bytes) = read_optional(&paths.journal)? else {
        return Ok(None);
    };
    let journal: Journal =
        serde_json::from_slice(&bytes).map_err(|_| LedgerEffectError::Uncertain)?;
    if journal.schema != "project-ledger.publication-transaction.v1"
        || journal.publication_id != attempt.publication_id
        || journal.canonical_root != occurrence.ledger_root
        || journal.candidate_root != paths.candidate.to_string_lossy()
        || journal.journal_path != paths.journal.to_string_lossy()
        || journal.claim_path != claim::path(Path::new(&occurrence.ledger_root)).to_string_lossy()
        || !journal.base.same_storage(&attempt.expected_base)
    {
        return Err(LedgerEffectError::Uncertain);
    }
    if matches!(
        journal.status,
        Status::Prepared | Status::Committing | Status::Promoted | Status::Observed
    ) != journal.candidate_head.is_some()
    {
        return Err(LedgerEffectError::Uncertain);
    }
    Ok(Some(journal))
}

pub(super) fn reconcile(
    data_root: &Path,
    occurrence: &Occurrence,
    collation: &LocaleCollation,
) -> Result<Reconciled, LedgerEffectError> {
    let attempt = occurrence
        .attempts
        .last()
        .ok_or(LedgerEffectError::Uncertain)?;
    let paths = paths(data_root, attempt);
    if let Some(receipt) = read_receipt(&paths, occurrence, attempt)? {
        return if receipt.status == ReceiptStatus::Observed {
            let journal = read_journal(&paths, occurrence, attempt)?;
            if let Some(journal) = journal.as_ref() {
                cleanup_applied(&paths, journal)?
            }
            Ok(Reconciled::Applied(Applied {
                publication_id: attempt.publication_id.clone(),
                base: receipt.base_head,
            }))
        } else {
            Ok(Reconciled::NotAppliedWithReceipt)
        };
    }
    let Some(journal) = read_journal(&paths, occurrence, attempt)? else {
        if paths.candidate.exists() || claim::path(Path::new(&occurrence.ledger_root)).exists() {
            return Err(LedgerEffectError::Uncertain);
        }
        write_receipt(&paths, occurrence, attempt, ReceiptStatus::NotApplied, None)?;
        return Ok(Reconciled::NotApplied);
    };
    if matches!(journal.status, Status::ClaimPending | Status::Preparing) {
        cleanup_prepared(&paths, &journal)?;
        write_receipt(&paths, occurrence, attempt, ReceiptStatus::NotApplied, None)?;
        return Ok(Reconciled::NotApplied);
    }
    if matches!(journal.status, Status::Promoted | Status::Observed) {
        return observed(&paths, &journal, occurrence, attempt, collation);
    }
    let active = head::observe(Path::new(&occurrence.ledger_root), collation)?;
    let candidate = journal
        .candidate_head
        .as_ref()
        .ok_or(LedgerEffectError::Uncertain)?;
    if active.same_storage(candidate) {
        return observed(&paths, &journal, occurrence, attempt, collation);
    }
    if journal.status == Status::Committing && !active.same_logical(&journal.base) {
        return Err(LedgerEffectError::Uncertain);
    }
    if journal.status == Status::Prepared && !active.same_logical(&journal.base) {
        cleanup_prepared(&paths, &journal)?;
        write_receipt(&paths, occurrence, attempt, ReceiptStatus::NotApplied, None)?;
        return Ok(Reconciled::NotApplied);
    }
    Ok(Reconciled::Ready)
}

fn observed(
    paths: &Paths,
    journal: &Journal,
    occurrence: &Occurrence,
    attempt: &Attempt,
    collation: &LocaleCollation,
) -> Result<Reconciled, LedgerEffectError> {
    let active = head::observe(Path::new(&occurrence.ledger_root), collation)?;
    if !active.same_storage(
        journal
            .candidate_head
            .as_ref()
            .ok_or(LedgerEffectError::Uncertain)?,
    ) {
        return Err(LedgerEffectError::Uncertain);
    }
    write_receipt(
        paths,
        occurrence,
        attempt,
        ReceiptStatus::Observed,
        journal.candidate_head.clone(),
    )?;
    cleanup_applied(paths, journal)?;
    Ok(Reconciled::Applied(Applied {
        publication_id: attempt.publication_id.clone(),
        base: journal.base.clone(),
    }))
}

pub(super) fn write_observed(
    paths: &Paths,
    journal: &Journal,
    occurrence: &Occurrence,
    attempt: &Attempt,
) -> Result<(), LedgerEffectError> {
    write_receipt(
        paths,
        occurrence,
        attempt,
        ReceiptStatus::Observed,
        journal.candidate_head.clone(),
    )
}

pub(super) fn write_not_applied(
    paths: &Paths,
    occurrence: &Occurrence,
    attempt: &Attempt,
) -> Result<(), LedgerEffectError> {
    write_receipt(paths, occurrence, attempt, ReceiptStatus::NotApplied, None)
}

fn read_receipt(
    paths: &Paths,
    occurrence: &Occurrence,
    attempt: &Attempt,
) -> Result<Option<Receipt>, LedgerEffectError> {
    let Some(bytes) = read_optional(&paths.receipt)? else {
        return Ok(None);
    };
    let receipt: Receipt =
        serde_json::from_slice(&bytes).map_err(|_| LedgerEffectError::Uncertain)?;
    if receipt.schema != "butler.btcc-project-ledger-publication-receipt.v1"
        || receipt.occurrence_id != occurrence.occurrence_id
        || receipt.attempt_number != attempt.number
        || receipt.request_sha256 != attempt.request_sha256
        || receipt.publication_id != attempt.publication_id
        || !receipt.base_head.same_storage(&attempt.expected_base)
        || (receipt.status == ReceiptStatus::Observed) != receipt.candidate_head.is_some()
    {
        return Err(LedgerEffectError::Uncertain);
    }
    Ok(Some(receipt))
}

fn write_receipt(
    paths: &Paths,
    occurrence: &Occurrence,
    attempt: &Attempt,
    status: ReceiptStatus,
    candidate_head: Option<LedgerHead>,
) -> Result<(), LedgerEffectError> {
    let receipt = Receipt {
        schema: "butler.btcc-project-ledger-publication-receipt.v1".into(),
        occurrence_id: occurrence.occurrence_id.clone(),
        attempt_number: attempt.number,
        request_sha256: attempt.request_sha256.clone(),
        publication_id: attempt.publication_id.clone(),
        status,
        base_head: attempt.expected_base.clone(),
        candidate_head,
    };
    shared::atomic_json(&paths.receipt, &receipt).map_err(|_| LedgerEffectError::Uncertain)
}

pub(super) fn cleanup_prepared(paths: &Paths, journal: &Journal) -> Result<(), LedgerEffectError> {
    commit::remove_directory(&paths.candidate)?;
    release(journal)?;
    match fs::remove_file(&paths.journal) {
        Ok(()) => Ok(()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(_) => Err(LedgerEffectError::Uncertain),
    }
}

pub(super) fn cleanup_applied(paths: &Paths, journal: &Journal) -> Result<(), LedgerEffectError> {
    commit::remove_directory(&paths.candidate)?;
    release(journal)
}

pub(super) fn release(journal: &Journal) -> Result<(), LedgerEffectError> {
    claim::release_if_owned(
        Path::new(&journal.claim_path),
        Path::new(&journal.canonical_root),
        &journal.publication_id,
        &journal.base.source_sha256,
    )
    .map_err(|_| LedgerEffectError::Uncertain)
}

fn read_optional(path: &Path) -> Result<Option<Vec<u8>>, LedgerEffectError> {
    match fs::read(path) {
        Ok(bytes) => Ok(Some(bytes)),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(_) => Err(LedgerEffectError::Uncertain),
    }
}
