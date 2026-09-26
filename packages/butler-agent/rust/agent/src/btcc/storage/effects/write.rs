use rusqlite::{Connection, TransactionBehavior, params};
use serde_json::Value;

use crate::btcc::effects::contracts::*;
use crate::btcc::effects::recovery;

use super::{receipt_json, row};

fn sql(error: rusqlite::Error) -> EffectFailure {
    EffectFailure::storage("sqlite_error", error.to_string())
}
fn json(value: &Value) -> EffectResult<String> {
    crate::json::stringify(value)
        .map_err(|error| EffectFailure::policy("effect_journal_json", error.to_string()))
}
fn serialized<T: serde::Serialize>(value: &T) -> EffectResult<String> {
    let object = serde_json::to_value(value)
        .map_err(|error| EffectFailure::policy("effect_journal_json", error.to_string()))?;
    json(&object)
}
fn same(left: &EffectIdentity, right: &EffectIdentity) -> bool {
    left.effect_id == right.effect_id
        && left.receipt_id == right.receipt_id
        && left.idempotency_key == right.idempotency_key
        && left.identity_sha256 == right.identity_sha256
        && left.request_sha256 == right.request_sha256
        && left.input_sha256 == right.input_sha256
        && left.target_sha256 == right.target_sha256
        && left.work_id == right.work_id
        && left.plan_revision_id == right.plan_revision_id
        && left.action_key == right.action_key
        && left.capability == right.capability
}
fn insert_recovery(db: &Connection, effect_id: &str, hint: &RecoveryHint) -> EffectResult<()> {
    match hint {
        RecoveryHint::Batch {
            capability,
            entries,
        } => {
            let value = serde_json::to_value(entries).map_err(|error| {
                EffectFailure::policy("effect_request_invalid", error.to_string())
            })?;
            let normalized = recovery::normalize_entries(&value)?;
            db.execute(
                "INSERT OR IGNORE INTO btcc_guided_effect_recovery_payloads \
                (effect_id,capability,payload_json) VALUES (?1,?2,?3)",
                params![effect_id, capability, serialized(&normalized)?],
            )
            .map_err(sql)?;
        }
        RecoveryHint::Single {
            capability,
            start_line,
            before_sha256,
            after_sha256,
        } => {
            db.execute("INSERT OR IGNORE INTO btcc_guided_effect_recovery_hints \
                (effect_id,capability,start_line,before_sha256,after_sha256) VALUES (?1,?2,?3,?4,?5)",
                params![effect_id,capability,start_line,before_sha256,after_sha256]).map_err(sql)?;
        }
    }
    Ok(())
}
pub(super) fn prepare(
    db: &mut Connection,
    identity: EffectIdentity,
    hint: Option<RecoveryHint>,
    clock: &dyn Fn() -> String,
) -> EffectResult<PrepareEffect> {
    let transaction = db
        .transaction_with_behavior(TransactionBehavior::Deferred)
        .map_err(sql)?;
    if let Some(existing) = row::find(&transaction, &identity.effect_id)? {
        if existing.recovery_hint.is_none()
            && let Some(hint) = hint.as_ref()
        {
            insert_recovery(&transaction, &identity.effect_id, hint)?;
        }
        transaction.commit().map_err(sql)?;
        return Ok(if same(&existing.identity, &identity) {
            PrepareEffect::Ready {
                created: false,
                record: Box::new(existing),
            }
        } else {
            PrepareEffect::Conflict(format!(
                "Guided effect identity conflicts with stored request: {}",
                identity.effect_id
            ))
        });
    }
    let now = clock();
    transaction
        .execute(
            "INSERT INTO btcc_guided_effects \
        (effect_id,receipt_id,idempotency_key,identity_sha256,request_sha256,input_sha256,
        target_sha256,work_id,plan_revision_id,action_key,capability,sanitized_target,
        status,journal_revision,dispatch_attempts,created_at,updated_at)
        VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,'prepared',1,0,?13,?13)",
            params![
                identity.effect_id,
                identity.receipt_id,
                identity.idempotency_key,
                identity.identity_sha256,
                identity.request_sha256,
                identity.input_sha256,
                identity.target_sha256,
                identity.work_id,
                identity.plan_revision_id,
                identity.action_key,
                identity.capability,
                identity.sanitized_target,
                now
            ],
        )
        .map_err(sql)?;
    if let Some(hint) = hint.as_ref() {
        insert_recovery(&transaction, &identity.effect_id, hint)?;
    }
    let record = row::find(&transaction, &identity.effect_id)?.ok_or_else(|| {
        EffectFailure::storage(
            "effect_journal_lost",
            format!("Guided effect journal lost {}", identity.effect_id),
        )
    })?;
    transaction.commit().map_err(sql)?;
    Ok(PrepareEffect::Ready {
        created: true,
        record: Box::new(record),
    })
}
pub(super) fn claim(
    db: &Connection,
    effect_id: &str,
    revision: i64,
    clock: &dyn Fn() -> String,
) -> EffectResult<Option<EffectRecord>> {
    let updated = db.execute("UPDATE btcc_guided_effects SET status='dispatching',journal_revision=journal_revision+1,
        dispatch_attempts=dispatch_attempts+1,error_json=NULL,updated_at=?1 WHERE effect_id=?2
        AND journal_revision=?3 AND status IN ('prepared','dispatching','uncertain')",
        params![clock(),effect_id,revision]).map_err(sql)?;
    if updated == 1 {
        row::find(db, effect_id)
    } else {
        Ok(None)
    }
}
pub(super) fn return_prepared(
    db: &Connection,
    effect_id: &str,
    revision: i64,
    clock: &dyn Fn() -> String,
) -> EffectResult<Option<EffectRecord>> {
    let updated = db.execute("UPDATE btcc_guided_effects SET status='prepared',error_json=NULL,
        journal_revision=journal_revision+1,updated_at=?1 WHERE effect_id=?2 AND journal_revision=?3 AND status='dispatching'",
        params![clock(),effect_id,revision]).map_err(sql)?;
    if updated == 1 {
        row::find(db, effect_id)
    } else {
        Ok(None)
    }
}
pub(super) fn record_applied(
    db: &Connection,
    effect_id: &str,
    revision: i64,
    result: &crate::json::JsonDocument,
    receipt: &EffectReceipt,
) -> EffectResult<Option<EffectRecord>> {
    let Some(current) = row::find(db, effect_id)? else {
        return Ok(None);
    };
    if !same(
        &current.identity,
        &EffectIdentity {
            effect_id: receipt.effect_id.clone(),
            receipt_id: receipt.receipt_id.clone(),
            idempotency_key: receipt.idempotency_key.clone(),
            identity_sha256: receipt.identity_sha256.clone(),
            request_sha256: receipt.request_sha256.clone(),
            input_sha256: receipt.input_sha256.clone(),
            target_sha256: receipt.target_sha256.clone(),
            work_id: receipt.work_id.clone(),
            plan_revision_id: receipt.plan_revision_id.clone(),
            action_key: receipt.action_key.clone(),
            capability: receipt.capability.clone(),
            sanitized_target: receipt.sanitized_target.clone(),
        },
    ) || current.identity.sanitized_target != receipt.sanitized_target
    {
        return Ok(None);
    }
    let result_json = result.as_str();
    if receipt.result != *result {
        return Ok(None);
    }
    let receipt_json = receipt_json::encode(receipt)?;
    let updated = db.execute("UPDATE btcc_guided_effects SET status='applied',journal_revision=journal_revision+1,
        result_json=?1,receipt_json=?2,error_json=NULL,updated_at=?3,applied_at=?3
        WHERE effect_id=?4 AND journal_revision=?5 AND status IN ('prepared','dispatching','uncertain')",
        params![result_json,receipt_json,receipt.applied_at,effect_id,revision]).map_err(sql)?;
    if updated == 1 {
        row::find(db, effect_id)
    } else {
        Ok(None)
    }
}
pub(super) fn record_error(
    db: &Connection,
    effect_id: &str,
    revision: i64,
    error: EffectError,
    failed: bool,
    clock: &dyn Fn() -> String,
) -> EffectResult<Option<EffectRecord>> {
    let status = if failed { "failed" } else { "uncertain" };
    let updated = db
        .execute(
            "UPDATE btcc_guided_effects SET status=?1,error_json=?2,
        journal_revision=journal_revision+1,updated_at=?3 WHERE effect_id=?4 AND journal_revision=?5
        AND status IN ('prepared','dispatching','uncertain') AND (?6=0 OR status='dispatching')",
            params![
                status,
                serialized(&error)?,
                clock(),
                effect_id,
                revision,
                failed as i64
            ],
        )
        .map_err(sql)?;
    if updated == 1 {
        row::find(db, effect_id)
    } else {
        Ok(None)
    }
}
