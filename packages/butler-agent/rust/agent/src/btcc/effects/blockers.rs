use std::collections::HashMap;

use super::contracts::*;
use super::{execution, identity, outcomes};

struct Classified {
    blocker: EffectBlocker,
    relation: BlockerRelation,
    custom: bool,
}

pub(super) async fn reconcile(
    context: &execution::Context<'_>,
    current: &EffectRecord,
) -> EffectResult<Option<EffectOutcome>> {
    let blockers = context
        .journal
        .blockers(context.resolved.identity.work_id.clone())
        .await?;
    let mut matching = Vec::new();
    for blocker in blockers {
        let (relation, custom) = classify(context, &blocker).await;
        if relation != BlockerRelation::Unrelated {
            matching.push(Classified {
                blocker,
                relation,
                custom,
            });
        }
    }
    if matching.is_empty() {
        return Ok(None);
    }
    let mut grouped: Vec<Classified> = Vec::new();
    let mut positions: HashMap<String, usize> = HashMap::new();
    for item in matching {
        if let Some(index) = positions.get(&item.blocker.source_occurrence_id) {
            let prior = &mut grouped[*index];
            if rank(item.relation) > rank(prior.relation) {
                prior.relation = item.relation;
            }
        } else {
            positions.insert(item.blocker.source_occurrence_id.clone(), grouped.len());
            grouped.push(item);
        }
    }
    let mut not_applied = Vec::new();
    let mut must_dispatch = false;
    let mut adopted_result: Option<crate::json::JsonDocument> = None;
    for Classified {
        blocker,
        relation,
        custom,
    } in grouped
    {
        let prior_input = match context.input.adapter.normalize_input(&blocker.input) {
            Ok(value) => value,
            Err(error) => {
                if blocker.status == "applied" && relation == BlockerRelation::Overlapping {
                    must_dispatch = true;
                    continue;
                }
                return Ok(Some(prior_error(error)));
            }
        };
        let prior_target = match context.input.adapter.normalize_target(&blocker.target) {
            Ok(value) => value,
            Err(error) => {
                if !custom {
                    return Ok(Some(prior_error(error)));
                }
                context.resolved.normalized_target.clone()
            }
        };
        let observed = context
            .input
            .adapter
            .reconcile(
                &prior_target,
                &prior_input,
                &blocker.idempotency_key,
                &context.input.signal,
                1,
                None,
            )
            .await;
        let observed = match observed {
            Ok(value) => value,
            Err(error) => {
                if blocker.status == "applied" && relation == BlockerRelation::Overlapping {
                    must_dispatch = true;
                    continue;
                }
                return Ok(Some(prior_error(error)));
            }
        };
        match observed {
            AdapterOutcome::Uncertain(error) => {
                if blocker.status == "applied" && relation == BlockerRelation::Overlapping {
                    must_dispatch = true;
                    continue;
                }
                return Ok(Some(outcomes::uncertain(
                    reconcile_error(error.as_ref()),
                    None,
                )));
            }
            AdapterOutcome::NotApplied(_) => {
                if blocker.status == "applied" {
                    if relation == BlockerRelation::Overlapping {
                        must_dispatch = true;
                        continue;
                    }
                    return Ok(Some(outcomes::uncertain(
                        EffectError::new(
                            "effect_reconciliation_required",
                            "Durable legacy evidence says the prior effect was applied, but its original occurrence can no longer confirm that result.",
                        ),
                        None,
                    )));
                }
                not_applied.push(blocker.source_occurrence_id);
            }
            AdapterOutcome::Applied(result) => {
                if blocker.status == "unresolved" {
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
                if relation == BlockerRelation::Ambiguous {
                    return Ok(Some(outcomes::uncertain(
                        EffectError::new(
                            "effect_reconciliation_required",
                            "A prior effect was applied, but its legacy target cannot be mapped uniquely to the current target.",
                        ),
                        None,
                    )));
                }
                if relation == BlockerRelation::Equivalent {
                    if adopted_result.is_none() {
                        adopted_result = Some(result);
                    }
                } else {
                    must_dispatch = true;
                }
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

fn prior_error(error: EffectFailure) -> EffectOutcome {
    outcomes::uncertain(
        EffectError::new("effect_reconciliation_required", error.message),
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
