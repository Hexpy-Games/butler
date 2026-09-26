//! Full-root, occurrence-bound Project Ledger effect publication.

mod commit;
mod contracts;
mod digest;
mod evidence;
mod head;
mod materialize;
mod occurrence;
mod scope;
mod targets;
mod transaction;

use std::path::Path;

use serde_json::{Value, json};

use crate::locale::LocaleCollation;

pub(crate) use contracts::{LedgerEffectError, LedgerEffectReconciliation, LedgerEffectRequest};
use evidence::{Applied, Reconciled};

pub(in crate::project_ledger) fn apply(
    data_root: &Path,
    request: &LedgerEffectRequest,
    collation: &LocaleCollation,
) -> Result<Value, LedgerEffectError> {
    match run(data_root, request, collation, false)? {
        LedgerEffectReconciliation::Applied(result) => Ok(result),
        LedgerEffectReconciliation::NotApplied => Err(LedgerEffectError::NotApplied),
        LedgerEffectReconciliation::Uncertain => Err(LedgerEffectError::Uncertain),
    }
}

pub(in crate::project_ledger) fn reconcile(
    data_root: &Path,
    request: &LedgerEffectRequest,
    collation: &LocaleCollation,
) -> Result<LedgerEffectReconciliation, LedgerEffectError> {
    match run(data_root, request, collation, true) {
        Ok(result) => Ok(result),
        Err(LedgerEffectError::Conflict) => Err(LedgerEffectError::Conflict),
        Err(_) => Ok(LedgerEffectReconciliation::Uncertain),
    }
}

fn run(
    data_root: &Path,
    request: &LedgerEffectRequest,
    collation: &LocaleCollation,
    only_reconcile: bool,
) -> Result<LedgerEffectReconciliation, LedgerEffectError> {
    if request.updates.is_empty() || request.effect_key.is_empty() {
        return Err(LedgerEffectError::Uncertain);
    }
    let scope = scope::resolve(&request.project_root)?;
    if occurrence::legacy_exists(
        data_root,
        &request.project_root,
        &scope.root,
        &request.effect_key,
    )? {
        return Ok(LedgerEffectReconciliation::Uncertain);
    }
    let value = serde_json::to_value(&request.updates).map_err(|_| LedgerEffectError::Uncertain)?;
    let request_sha256 = digest::request(&value, collation)?;
    if let Some(existing) =
        occurrence::read(data_root, &scope, &request.effect_key, &request_sha256)?
    {
        match evidence::reconcile(data_root, &existing, collation)? {
            Reconciled::Applied(applied) => {
                return result(&scope, request, &applied, collation)
                    .map(LedgerEffectReconciliation::Applied);
            }
            Reconciled::Ready => {
                let applied =
                    transaction::apply(data_root, &scope, &existing, &request.updates, collation)?;
                return result(&scope, request, &applied, collation)
                    .map(LedgerEffectReconciliation::Applied);
            }
            Reconciled::NotAppliedWithReceipt if !only_reconcile => {
                let (base, targets) = snapshot(&scope, &request.updates, collation)?;
                let next = occurrence::append(
                    data_root,
                    &scope,
                    &request.effect_key,
                    &request_sha256,
                    &existing,
                    base,
                    targets,
                )?;
                let applied =
                    transaction::apply(data_root, &scope, &next, &request.updates, collation)?;
                return result(&scope, request, &applied, collation)
                    .map(LedgerEffectReconciliation::Applied);
            }
            Reconciled::NotAppliedWithReceipt | Reconciled::NotApplied => {
                return Ok(LedgerEffectReconciliation::NotApplied);
            }
        }
    }
    if only_reconcile {
        return Ok(LedgerEffectReconciliation::NotApplied);
    }
    let (base, targets) = snapshot(&scope, &request.updates, collation)?;
    let admitted = occurrence::admit(
        data_root,
        &scope,
        &request.effect_key,
        &request_sha256,
        base,
        targets,
    )?;
    let applied = transaction::apply(data_root, &scope, &admitted, &request.updates, collation)?;
    result(&scope, request, &applied, collation).map(LedgerEffectReconciliation::Applied)
}

fn snapshot(
    scope: &scope::LedgerScope,
    updates: &[super::ProjectLedgerRecordUpdate],
    collation: &LocaleCollation,
) -> Result<(head::LedgerHead, Vec<super::contracts::ProjectWorkTarget>), LedgerEffectError> {
    for _ in 0..3 {
        let before = head::observe(&scope.root, collation)?;
        let targets = targets::capture(scope, updates)?;
        let after = head::observe(&scope.root, collation)?;
        if before.same_storage(&after) {
            return Ok((after, targets));
        }
    }
    Err(LedgerEffectError::Uncertain)
}

fn result(
    scope: &scope::LedgerScope,
    request: &LedgerEffectRequest,
    applied: &Applied,
    collation: &LocaleCollation,
) -> Result<Value, LedgerEffectError> {
    let current = head::observe(&scope.root, collation)?;
    let records = request
        .updates
        .iter()
        .map(|update| {
            let mut record = json!({"id":update.id});
            if let Some(kind) = &update.kind {
                record["kind"] = Value::String(kind.as_str().into());
            }
            record
        })
        .collect::<Vec<_>>();
    Ok(json!({
        "schema":"butler.btcc-project-ledger-effect-result.v1",
        "publicationId":applied.publication_id,
        "effectKey":request.effect_key,
        "updatedRecords":records,
        "baseHead":applied.base.public(),
        "currentHead":current.public(),
        "promotion":{"status":"promoted"},
        "observation":{"status":"observed"},
    }))
}
