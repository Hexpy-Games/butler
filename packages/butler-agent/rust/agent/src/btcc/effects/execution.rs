use serde_json::json;

use super::contracts::*;
use super::{identity::Resolved, outcomes};

pub(super) struct Context<'a> {
    pub input: &'a ExecuteEffect,
    pub resolved: &'a Resolved,
    pub journal: &'a dyn EffectJournal,
    pub clock: &'a (dyn Fn() -> String + Send + Sync),
    pub fault: &'a dyn EffectFaultHook,
}

pub(super) async fn continue_effect(
    context: &Context<'_>,
    initial: &EffectRecord,
) -> EffectResult<EffectOutcome> {
    match initial.status {
        EffectStatus::Applied => return Ok(outcomes::replay(initial)),
        EffectStatus::Failed => {
            return Ok(EffectOutcome::Failed(initial.error.clone().unwrap_or_else(
                || {
                    EffectError::new(
                        "effect_journal_conflict",
                        "Stored effect failure is incomplete.",
                    )
                },
            )));
        }
        _ => {}
    }
    if context.input.signal.is_cancelled() {
        return Ok(EffectOutcome::Rejected(EffectError::new(
            "effect_cancelled",
            "Effect execution was cancelled before reconciliation or dispatch.",
        )));
    }
    if initial.status == EffectStatus::Dispatching
        || (initial.status == EffectStatus::Prepared && initial.dispatch_attempts == 0)
    {
        return reconcile(context, initial).await;
    }
    dispatch(context, initial).await
}

pub(super) async fn reconcile(
    context: &Context<'_>,
    current: &EffectRecord,
) -> EffectResult<EffectOutcome> {
    let adapter = context.input.adapter.as_ref();
    let observation = adapter
        .reconcile(
            &context.resolved.normalized_target,
            &context.resolved.normalized_input,
            &context.resolved.identity.idempotency_key,
            &context.input.signal,
            current.dispatch_attempts,
            current.error.as_ref(),
        )
        .await;
    let observation = match observation {
        Ok(value) => value,
        Err(error) => {
            let diagnostic = EffectError::new("effect_reconciliation_required", error.message());
            return record_uncertain(context, current, diagnostic).await;
        }
    };
    match observation {
        AdapterOutcome::Applied(result) => record_applied(context, current, result).await,
        AdapterOutcome::Uncertain(error) => {
            let diagnostic = reconciliation_error(error.as_ref());
            record_uncertain(context, current, diagnostic).await
        }
        AdapterOutcome::NotApplied(_) => dispatch(context, current).await,
    }
}

async fn dispatch(context: &Context<'_>, current: &EffectRecord) -> EffectResult<EffectOutcome> {
    if let Some(denied) = outcomes::permission(context.input) {
        return Ok(EffectOutcome::Rejected(denied));
    }
    let identity = &context.resolved.identity;
    let Some(claimed) = context
        .journal
        .claim_dispatch(current.identity.effect_id.clone(), current.journal_revision)
        .await?
    else {
        return outcomes::resolve_conflict(context.journal, identity).await;
    };
    context
        .fault
        .reached("after_dispatch_marker", identity)
        .await?;
    if let Some(denied) = outcomes::permission(context.input) {
        return Ok(
            if context
                .journal
                .return_prepared(claimed.identity.effect_id.clone(), claimed.journal_revision)
                .await?
                .is_some()
            {
                EffectOutcome::Rejected(denied)
            } else {
                outcomes::resolve_conflict(context.journal, identity).await?
            },
        );
    }
    let adapter = context.input.adapter.as_ref();
    let response = adapter
        .dispatch(
            &context.resolved.normalized_target,
            &context.resolved.normalized_input,
            &identity.idempotency_key,
            &context.input.signal,
        )
        .await;
    let response = match response {
        Ok(response) => response,
        Err(error) => {
            return record_uncertain(
                context,
                &claimed,
                EffectError::new("effect_reconciliation_required", error.message()),
            )
            .await;
        }
    };
    match response {
        AdapterOutcome::NotApplied(error) => {
            let diagnostic = EffectError {
                code: "effect_dispatch_failed".into(),
                message: format!("{}: {}", error.code, error.message),
                recoverable: error.recoverable.unwrap_or(true),
                source_code: None,
            };
            let recorded = context
                .journal
                .record_failed(
                    claimed.identity.effect_id.clone(),
                    claimed.journal_revision,
                    diagnostic.clone(),
                )
                .await?;
            if recorded.is_some() {
                Ok(EffectOutcome::Failed(diagnostic))
            } else {
                outcomes::resolve_conflict(context.journal, identity).await
            }
        }
        AdapterOutcome::Uncertain(error) => {
            record_uncertain(context, &claimed, reconciliation_error(error.as_ref())).await
        }
        AdapterOutcome::Applied(result) => {
            context.fault.reached("after_dispatch", identity).await?;
            record_applied(context, &claimed, result).await
        }
    }
}

fn reconciliation_error(error: Option<&EffectAdapterError>) -> EffectError {
    let mut diagnostic = EffectError::new(
        "effect_reconciliation_required",
        error.map_or_else(
            || "The target cannot yet prove whether this effect was applied.".to_owned(),
            |error| format!("{}: {}", error.code, error.message),
        ),
    );
    diagnostic.source_code = error.map(|error| error.code.clone());
    diagnostic
}

pub(super) async fn record_uncertain(
    context: &Context<'_>,
    current: &EffectRecord,
    diagnostic: EffectError,
) -> EffectResult<EffectOutcome> {
    let recorded = context
        .journal
        .record_uncertain(
            current.identity.effect_id.clone(),
            current.journal_revision,
            diagnostic.clone(),
        )
        .await?;
    if let Some(record) = recorded {
        Ok(outcomes::uncertain(diagnostic, outcomes::evidence(&record)))
    } else {
        outcomes::resolve_conflict(context.journal, &context.resolved.identity).await
    }
}

pub(super) async fn record_applied(
    context: &Context<'_>,
    current: &EffectRecord,
    result: crate::json::JsonDocument,
) -> EffectResult<EffectOutcome> {
    let identity = &context.resolved.identity;
    let receipt = EffectReceipt {
        effect_id: identity.effect_id.clone(),
        receipt_id: identity.receipt_id.clone(),
        idempotency_key: identity.idempotency_key.clone(),
        identity_sha256: identity.identity_sha256.clone(),
        request_sha256: identity.request_sha256.clone(),
        input_sha256: identity.input_sha256.clone(),
        target_sha256: identity.target_sha256.clone(),
        work_id: identity.work_id.clone(),
        plan_revision_id: identity.plan_revision_id.clone(),
        action_key: identity.action_key.clone(),
        capability: identity.capability.clone(),
        sanitized_target: current.identity.sanitized_target.clone(),
        result: result.clone(),
        applied_at: (context.clock)(),
        dispatch_attempt: Some(json!(current.dispatch_attempts)),
    };
    let recorded = context
        .journal
        .record_applied(
            current.identity.effect_id.clone(),
            current.journal_revision,
            result.clone(),
            receipt.clone(),
        )
        .await?;
    if recorded.is_none() {
        return outcomes::resolve_conflict(context.journal, identity).await;
    }
    context.fault.reached("after_receipt", identity).await?;
    Ok(EffectOutcome::Applied {
        replayed: false,
        result,
        receipt: Box::new(receipt),
    })
}
