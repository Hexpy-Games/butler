use std::fs;
use std::path::Path;

use super::commit;
use super::contracts::LedgerEffectError;
use super::evidence::{self, Applied, Journal, Paths, Reconciled, Status};
use super::head;
use super::occurrence::{Attempt, Occurrence};
use super::scope::LedgerScope;
use super::targets;
use crate::locale::LocaleCollation;
use crate::project_ledger::publication::ProjectLedgerRecordUpdate;
use crate::project_ledger::publication::transaction::claim;

pub(super) fn apply(
    data_root: &Path,
    scope: &LedgerScope,
    occurrence: &Occurrence,
    updates: &[ProjectLedgerRecordUpdate],
    collation: &LocaleCollation,
) -> Result<Applied, LedgerEffectError> {
    let attempt = occurrence
        .attempts
        .last()
        .ok_or(LedgerEffectError::Uncertain)?;
    let paths = evidence::paths(data_root, attempt);
    let existing = evidence::read_journal(&paths, occurrence, attempt)?;
    let result = (|| {
        targets::revalidate(scope, &attempt.target_preconditions)?;
        let active = head::observe(&scope.root, collation)?;
        if !active.same_logical(&attempt.expected_base) {
            return Err(LedgerEffectError::NotApplied);
        }
        let mut journal = match existing {
            Some(journal) if matches!(journal.status, Status::Prepared | Status::Committing) => {
                journal
            }
            Some(_) => return Err(LedgerEffectError::Uncertain),
            None => prepare(scope, attempt, &paths, updates, collation)?,
        };
        promote(scope, &paths, &mut journal, collation)?;
        observe(scope, occurrence, attempt, &paths, &mut journal, collation)?;
        Ok(Applied {
            publication_id: attempt.publication_id.clone(),
            base: attempt.expected_base.clone(),
        })
    })();
    match result {
        Ok(applied) => Ok(applied),
        Err(error) => match evidence::reconcile(data_root, occurrence, collation) {
            Ok(Reconciled::Applied(applied)) => Ok(applied),
            Ok(Reconciled::Ready) => {
                let journal = evidence::read_journal(&paths, occurrence, attempt)?;
                if journal
                    .as_ref()
                    .is_some_and(|journal| journal.status == Status::Committing)
                {
                    return Err(LedgerEffectError::Uncertain);
                }
                if let Some(journal) = journal.as_ref() {
                    evidence::cleanup_prepared(&paths, journal)?;
                }
                evidence::write_not_applied(&paths, occurrence, attempt)?;
                Err(LedgerEffectError::NotApplied)
            }
            Ok(Reconciled::NotApplied | Reconciled::NotAppliedWithReceipt) => {
                Err(LedgerEffectError::NotApplied)
            }
            Err(_) => Err(error),
        },
    }
}

fn prepare(
    scope: &LedgerScope,
    attempt: &Attempt,
    paths: &Paths,
    updates: &[ProjectLedgerRecordUpdate],
    collation: &LocaleCollation,
) -> Result<Journal, LedgerEffectError> {
    let active = head::observe(&scope.root, collation)?;
    if !active.same_logical(&attempt.expected_base) {
        return Err(LedgerEffectError::NotApplied);
    }
    let mut journal = evidence::new_journal(&scope.root, attempt, paths);
    evidence::save_journal(paths, &journal)?;
    claim::acquire(
        &scope.root,
        &attempt.publication_id,
        &attempt.expected_base.source_sha256,
        &paths.journal,
    )
    .map_err(|_| LedgerEffectError::Uncertain)?;
    let result = (|| {
        journal.status = Status::Preparing;
        evidence::save_journal(paths, &journal)?;
        commit::remove_directory(&paths.candidate)?;
        commit::copy_root(&scope.root, &paths.candidate)?;
        super::materialize::apply(&paths.candidate, updates, collation)?;
        super::materialize::inspect(&paths.candidate, collation)?;
        journal.candidate_head = Some(head::inspect(&paths.candidate, collation)?);
        journal.status = Status::Prepared;
        evidence::save_journal(paths, &journal)?;
        Ok(journal.clone())
    })();
    if result.is_err() {
        let _ = commit::remove_directory(&paths.candidate);
        let _ = fs::remove_file(&paths.journal);
        let _ = evidence::release(&journal);
    }
    result
}

fn promote(
    scope: &LedgerScope,
    paths: &Paths,
    journal: &mut Journal,
    collation: &LocaleCollation,
) -> Result<(), LedgerEffectError> {
    claim::assert_owned(
        Path::new(&journal.claim_path),
        &scope.root,
        &journal.publication_id,
        &journal.base.source_sha256,
    )
    .map_err(|_| LedgerEffectError::Uncertain)?;
    let candidate = journal
        .candidate_head
        .as_ref()
        .ok_or(LedgerEffectError::Uncertain)?;
    if journal.status == Status::Prepared {
        let active = head::observe(&scope.root, collation)?;
        if active.same_storage(candidate) {
            journal.status = Status::Promoted;
            evidence::save_journal(paths, journal)?;
            return Ok(());
        }
        if !active.same_logical(&journal.base) {
            return Err(LedgerEffectError::NotApplied);
        }
        if !paths.candidate.exists() {
            return Err(LedgerEffectError::Uncertain);
        }
        let prepared = head::inspect(&paths.candidate, collation)?;
        if !prepared.same_storage(candidate) {
            return Err(LedgerEffectError::Uncertain);
        }
        journal.status = Status::Committing;
        evidence::save_journal(paths, journal)?;
    }
    if journal.status == Status::Committing {
        let active = head::observe(&scope.root, collation)?;
        if !active.same_storage(candidate) {
            if !active.same_logical(&journal.base) {
                return Err(LedgerEffectError::Uncertain);
            }
            commit::exchange(&paths.candidate, &scope.root)?;
        }
        let active = head::inspect(&scope.root, collation)?;
        if !active.same_storage(candidate) {
            return Err(LedgerEffectError::Uncertain);
        }
        journal.status = Status::Promoted;
        evidence::save_journal(paths, journal)?;
    }
    Ok(())
}

fn observe(
    scope: &LedgerScope,
    occurrence: &Occurrence,
    attempt: &Attempt,
    paths: &Paths,
    journal: &mut Journal,
    collation: &LocaleCollation,
) -> Result<(), LedgerEffectError> {
    let active = head::inspect(&scope.root, collation)?;
    if !active.same_storage(
        journal
            .candidate_head
            .as_ref()
            .ok_or(LedgerEffectError::Uncertain)?,
    ) {
        return Err(LedgerEffectError::Uncertain);
    }
    evidence::write_observed(paths, journal, occurrence, attempt)?;
    journal.status = Status::Observed;
    evidence::save_journal(paths, journal)?;
    evidence::cleanup_applied(paths, journal)
}
