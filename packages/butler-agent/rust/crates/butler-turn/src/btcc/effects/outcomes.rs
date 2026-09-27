use serde_json::json;

use super::contracts::*;

pub(super) fn permission(input: &ExecuteEffect) -> Option<EffectError> {
    if input.signal.is_cancelled() {
        Some(EffectError::new(
            "effect_cancelled",
            "Effect dispatch was cancelled before the external call.",
        ))
    } else if input.access != Access::Full {
        Some(EffectError::new(
            "effect_access_denied",
            "Effect dispatch requires full_access.",
        ))
    } else {
        None
    }
}

pub(super) fn same_identity(record: &EffectRecord, identity: &EffectIdentity) -> bool {
    let left = &record.identity;
    left.effect_id == identity.effect_id
        && left.receipt_id == identity.receipt_id
        && left.idempotency_key == identity.idempotency_key
        && left.identity_sha256 == identity.identity_sha256
        && left.request_sha256 == identity.request_sha256
        && left.input_sha256 == identity.input_sha256
        && left.target_sha256 == identity.target_sha256
        && left.work_id == identity.work_id
        && left.plan_revision_id == identity.plan_revision_id
        && left.action_key == identity.action_key
        && left.capability == identity.capability
}

pub(super) fn evidence(record: &EffectRecord) -> Option<UncertainEvidence> {
    if record.status != EffectStatus::Uncertain
        || record.dispatch_attempts <= 0
        || record.error.is_none()
    {
        return None;
    }
    Some(UncertainEvidence {
        effect_id: record.identity.effect_id.clone(),
        identity_sha256: record.identity.identity_sha256.clone(),
        dispatch_attempt: record.dispatch_attempts,
        error_code: record.error.as_ref()?.code.clone(),
    })
}
pub(super) fn uncertain(error: EffectError, evidence: Option<UncertainEvidence>) -> EffectOutcome {
    EffectOutcome::Uncertain { error, evidence }
}
pub(super) fn journal_conflict() -> EffectOutcome {
    uncertain(
        EffectError::new(
            "effect_journal_conflict",
            "The effect journal changed concurrently; reconcile before another dispatch.",
        ),
        None,
    )
}
pub(super) fn stored_uncertain(record: &EffectRecord) -> EffectOutcome {
    uncertain(
        record.error.clone().unwrap_or_else(|| {
            EffectError::new(
                "effect_journal_conflict",
                "Stored effect uncertainty is incomplete.",
            )
        }),
        evidence(record),
    )
}
pub(super) fn replay(record: &EffectRecord) -> EffectOutcome {
    let (Some(result), Some(receipt)) = (&record.result, &record.receipt) else {
        return journal_conflict();
    };
    let mut receipt = receipt.clone();
    receipt.result = result.clone();
    let stored_attempt = receipt.dispatch_attempt.as_ref().filter(|value| {
        value
            .as_f64()
            .is_some_and(|number| number.is_finite() && number.fract() == 0.0 && number >= 0.0)
    });
    receipt.dispatch_attempt = Some(
        stored_attempt
            .cloned()
            .unwrap_or_else(|| json!(record.dispatch_attempts)),
    );
    EffectOutcome::Applied {
        replayed: true,
        result: result.clone(),
        receipt: Box::new(receipt),
    }
}
pub(super) async fn resolve_conflict(
    journal: &dyn EffectJournal,
    identity: &EffectIdentity,
) -> EffectResult<EffectOutcome> {
    let Some(record) = journal.find(identity.effect_id.clone()).await? else {
        return Ok(journal_conflict());
    };
    if !same_identity(&record, identity) {
        return Ok(journal_conflict());
    }
    Ok(match record.status {
        EffectStatus::Applied => replay(&record),
        EffectStatus::Uncertain => stored_uncertain(&record),
        EffectStatus::Failed => EffectOutcome::Failed(record.error.unwrap_or_else(|| {
            EffectError::new(
                "effect_journal_conflict",
                "Stored effect failure is incomplete.",
            )
        })),
        _ if record.dispatch_attempts > 0 => uncertain(
            EffectError::new(
                "effect_journal_conflict",
                "The effect journal changed concurrently; reconcile before another dispatch.",
            ),
            Some(UncertainEvidence {
                effect_id: record.identity.effect_id,
                identity_sha256: record.identity.identity_sha256,
                dispatch_attempt: record.dispatch_attempts,
                error_code: "effect_journal_conflict".into(),
            }),
        ),
        _ => journal_conflict(),
    })
}
