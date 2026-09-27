use std::collections::HashMap;

use super::contracts::*;
use super::{execution, identity, outcomes};

struct Classified {
    blocker: EffectBlocker,
    relation: BlockerRelation,
    custom: bool,
}

/// What one legacy blocker says about the current effect.
enum Verdict {
    /// The effect settles now with this outcome.
    Settled(EffectOutcome),
    /// The current effect must still be dispatched.
    Dispatch,
    /// The prior occurrence was not applied; its blockers resolve as such.
    NotApplied(String),
    /// An equivalent prior occurrence was applied with this result.
    Adopt(butler_core::json::JsonDocument),
}

/// Reconciles the Work's legacy effect blockers related to the current
/// effect. Returns the settled outcome, or `None` when the effect must still
/// be dispatched (or is already applied).
pub(super) async fn reconcile(
    context: &execution::Context<'_>,
    current: &EffectRecord,
) -> EffectResult<Option<EffectOutcome>> {
    let related = related_blockers(context).await?;
    if related.is_empty() {
        return Ok(None);
    }
    let mut not_applied = Vec::new();
    let mut must_dispatch = false;
    let mut adopted_result = None;
    for classified in related {
        match reconcile_blocker(context, classified).await? {
            Verdict::Settled(outcome) => return Ok(Some(outcome)),
            Verdict::Dispatch => must_dispatch = true,
            Verdict::NotApplied(occurrence) => not_applied.push(occurrence),
            Verdict::Adopt(result) => {
                adopted_result.get_or_insert(result);
            }
        }
    }
    for occurrence in not_applied {
        context
            .journal
            .resolve_blockers(
                context.resolved.identity.work_id.clone(),
                occurrence,
                "not_applied".into(),
            )
            .await?;
    }
    if must_dispatch || current.status == EffectStatus::Applied {
        return Ok(None);
    }
    let Some(result) = adopted_result else {
        return Ok(None);
    };
    Ok(Some(
        execution::record_applied(context, current, result).await?,
    ))
}

/// The Work's blockers related to the current effect, one per source
/// occurrence with its strongest relation.
async fn related_blockers(context: &execution::Context<'_>) -> EffectResult<Vec<Classified>> {
    let blockers = context
        .journal
        .blockers(context.resolved.identity.work_id.clone())
        .await?;
    let mut grouped: Vec<Classified> = Vec::new();
    let mut positions: HashMap<String, usize> = HashMap::new();
    for blocker in blockers {
        let (relation, custom) = classify(context, &blocker).await;
        if relation == BlockerRelation::Unrelated {
            continue;
        }
        let prior = positions
            .get(&blocker.source_occurrence_id)
            .and_then(|index| grouped.get_mut(*index));
        if let Some(prior) = prior {
            if rank(relation) > rank(prior.relation) {
                prior.relation = relation;
            }
            continue;
        }
        positions.insert(blocker.source_occurrence_id.clone(), grouped.len());
        grouped.push(Classified {
            blocker,
            relation,
            custom,
        });
    }
    Ok(grouped)
}

/// Asks the adapter whether the blocker's prior occurrence was applied. An
/// applied overlapping blocker that cannot be confirmed only forces dispatch.
async fn reconcile_blocker(
    context: &execution::Context<'_>,
    classified: Classified,
) -> EffectResult<Verdict> {
    let Classified {
        blocker,
        relation,
        custom,
    } = classified;
    let overlapping_applied =
        blocker.status == BlockerStatus::Applied && relation == BlockerRelation::Overlapping;
    let unconfirmed = |outcome: EffectOutcome| {
        if overlapping_applied {
            Verdict::Dispatch
        } else {
            Verdict::Settled(outcome)
        }
    };
    let adapter = &context.input.adapter;
    let prior_input = match adapter.normalize_input(&blocker.input) {
        Ok(value) => value,
        Err(error) => return Ok(unconfirmed(prior_error(&error))),
    };
    let prior_target = match adapter.normalize_target(&blocker.target) {
        Ok(value) => value,
        Err(error) if !custom => return Ok(Verdict::Settled(prior_error(&error))),
        Err(_) => context.resolved.normalized_target.clone(),
    };
    let observed = adapter
        .reconcile(
            &prior_target,
            &prior_input,
            &blocker.idempotency_key,
            &context.input.signal,
            1,
            None,
        )
        .await;
    let result = match observed {
        Err(error) => return Ok(unconfirmed(prior_error(&error))),
        Ok(AdapterOutcome::Uncertain(error)) => {
            return Ok(unconfirmed(outcomes::uncertain(
                reconcile_error(error.as_ref()),
                None,
            )));
        }
        Ok(AdapterOutcome::NotApplied(_)) if blocker.status == BlockerStatus::Applied => {
            return Ok(unconfirmed(outcomes::uncertain(
                EffectError::new(
                    "effect_reconciliation_required",
                    "Durable legacy evidence says the prior effect was applied, but its original occurrence can no longer confirm that result.",
                ),
                None,
            )));
        }
        Ok(AdapterOutcome::NotApplied(_)) => {
            return Ok(Verdict::NotApplied(blocker.source_occurrence_id));
        }
        Ok(AdapterOutcome::Applied(result)) => result,
    };
    if blocker.status == BlockerStatus::Unresolved {
        context
            .journal
            .resolve_blockers(
                context.resolved.identity.work_id.clone(),
                blocker.source_occurrence_id.clone(),
                "applied".into(),
            )
            .await?;
        context
            .fault
            .reached("after_blocker_resolution", &context.resolved.identity)
            .await?;
    }
    Ok(match relation {
        BlockerRelation::Ambiguous => Verdict::Settled(outcomes::uncertain(
            EffectError::new(
                "effect_reconciliation_required",
                "A prior effect was applied, but its legacy target cannot be mapped uniquely to the current target.",
            ),
            None,
        )),
        BlockerRelation::Equivalent => Verdict::Adopt(result),
        BlockerRelation::Overlapping | BlockerRelation::Unrelated => Verdict::Dispatch,
    })
}

fn prior_error(error: &EffectFailure) -> EffectOutcome {
    outcomes::uncertain(
        EffectError::new("effect_reconciliation_required", error.message()),
        None,
    )
}
fn reconcile_error(error: Option<&EffectAdapterError>) -> EffectError {
    let mut value = EffectError::new(
        "effect_reconciliation_required",
        error.map_or_else(
            || "The target cannot yet prove whether this effect was applied.".to_owned(),
            |error| format!("{}: {}", error.code, error.message),
        ),
    );
    value.source_code = error.map(|error| error.code.clone());
    value
}
fn rank(value: BlockerRelation) -> u8 {
    match value {
        BlockerRelation::Overlapping => 1,
        BlockerRelation::Ambiguous => 2,
        BlockerRelation::Equivalent | BlockerRelation::Unrelated => 0,
    }
}
async fn classify(
    context: &execution::Context<'_>,
    blocker: &EffectBlocker,
) -> (BlockerRelation, bool) {
    let adapter = context.input.adapter.as_ref();
    if let Some(future) = adapter.classify(
        blocker,
        &context.resolved.normalized_target,
        &context.resolved.normalized_input,
    ) {
        return (future.await.unwrap_or(BlockerRelation::Ambiguous), true);
    }
    if blocker.capability != adapter.capability() {
        return (BlockerRelation::Unrelated, false);
    }
    let same_input = || -> EffectResult<bool> {
        let normalized = adapter.normalize_input(&blocker.input)?;
        Ok(identity::stable(&normalized)? == identity::stable(&context.resolved.normalized_input)?)
    };
    let relation = match adapter.normalize_target(&blocker.target) {
        Ok(target) if target != context.resolved.normalized_target => BlockerRelation::Unrelated,
        Ok(_) => match same_input() {
            Ok(true) => BlockerRelation::Equivalent,
            Ok(false) => BlockerRelation::Overlapping,
            Err(_) => match same_input() {
                Ok(true) => BlockerRelation::Equivalent,
                _ => BlockerRelation::Unrelated,
            },
        },
        Err(_) => match same_input() {
            Ok(true) => BlockerRelation::Equivalent,
            _ => BlockerRelation::Unrelated,
        },
    };
    (relation, false)
}
