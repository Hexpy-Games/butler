use std::collections::{HashMap, HashSet};

use serde_json::{Value, json};

use crate::btcc::BtccError;

use super::contracts::{
    ActionProgress, ActionStatus, CorrectionScope, PlanAction, ReviewSubject, ReviewVerdict,
    WorkReview, WorkStage, WorkStatus, WorkView,
};

pub(crate) fn progress_for_replacement_plan(
    actions: &[PlanAction],
    prior: &[ActionProgress],
) -> Vec<ActionProgress> {
    let prior_by_key: HashMap<&str, &ActionProgress> = prior
        .iter()
        .map(|item| (item.action_key.as_str(), item))
        .collect();
    actions
        .iter()
        .map(|action| {
            prior_by_key.get(action.action_key.as_str()).map_or_else(
                || ActionProgress {
                    action_key: action.action_key.clone(),
                    status: ActionStatus::Pending,
                    note: None,
                },
                |progress| (*progress).clone(),
            )
        })
        .collect()
}

pub(crate) fn apply_work_action_updates(
    work: &WorkView,
    updates: &[ActionProgress],
) -> Result<Vec<ActionProgress>, BtccError> {
    let plan = work
        .current_plan
        .as_ref()
        .ok_or_else(|| error("Durable Work progress requires a current Plan"))?;
    let action_keys: HashSet<&str> = plan
        .actions
        .iter()
        .map(|action| action.action_key.as_str())
        .collect();
    let mut update_keys = HashSet::with_capacity(updates.len());
    for update in updates {
        if !action_keys.contains(update.action_key.as_str()) {
            return Err(error(format!(
                "Durable Work action is not in the current Plan: {}",
                update.action_key
            )));
        }
        if !update_keys.insert(update.action_key.as_str()) {
            return Err(error(format!(
                "Durable Work action update is duplicated: {}",
                update.action_key
            )));
        }
    }
    let updates_by_key: HashMap<&str, &ActionProgress> = updates
        .iter()
        .map(|item| (item.action_key.as_str(), item))
        .collect();
    Ok(
        progress_for_replacement_plan(&plan.actions, &work.action_progress)
            .into_iter()
            .map(
                |progress| match updates_by_key.get(progress.action_key.as_str()) {
                    Some(update) => (*update).clone(),
                    None => progress,
                },
            )
            .collect(),
    )
}

pub(crate) fn resolve_work_review_transition(
    current_stage: WorkStage,
    subject: ReviewSubject,
    verdict: ReviewVerdict,
    correction_scope: Option<CorrectionScope>,
) -> Result<(WorkStage, WorkStage), BtccError> {
    let entry_stage = if subject == ReviewSubject::Completion {
        WorkStage::Validation
    } else {
        WorkStage::Review
    };
    if !review_entry_stages(subject).contains(&current_stage) {
        return Err(guard_error(
            current_stage,
            &format!("{}_review_{}", subject_name(subject), verdict_name(verdict)),
            review_guard(current_stage),
            review_next_action(current_stage),
        ));
    }
    if verdict != ReviewVerdict::Accept
        && subject != ReviewSubject::Plan
        && correction_scope.is_none()
    {
        return Err(guard_error(
            current_stage,
            &format!("{}_review_{}", subject_name(subject), verdict_name(verdict)),
            "correction_scope_required",
            "choose_planning_or_execution_correction",
        ));
    }
    assert_stage_transition(current_stage, entry_stage)?;
    let next_stage = review_target_stage(subject, verdict, correction_scope)?;
    assert_stage_transition(entry_stage, next_stage)?;
    Ok((entry_stage, next_stage))
}

pub(crate) fn accepted_current_result_review(work: &WorkView) -> Option<&WorkReview> {
    let review = work.latest_result_review.as_ref()?;
    if work.current_plan.is_none() || review.verdict != ReviewVerdict::Accept {
        return None;
    }
    let current: Vec<&str> = work
        .result_refs
        .iter()
        .map(|result| result.result_ref.as_str())
        .collect();
    let bound: Vec<&str> = review
        .bound_result_refs
        .iter()
        .map(String::as_str)
        .collect();
    let current_set: HashSet<&str> = current.iter().copied().collect();
    let bound_set: HashSet<&str> = bound.iter().copied().collect();
    if current.len() != current_set.len()
        || bound.len() != bound_set.len()
        || current_set.len() != bound_set.len()
    {
        return None;
    }
    bound_set
        .iter()
        .all(|reference| current_set.contains(reference))
        .then_some(review)
}

pub(crate) fn allowed_next_work_stages(stage: Option<WorkStage>) -> Vec<WorkStage> {
    match stage {
        None => vec![WorkStage::Conception],
        Some(WorkStage::Conception) => vec![WorkStage::Planning],
        Some(WorkStage::Planning) | Some(WorkStage::Execution) => vec![WorkStage::Review],
        Some(WorkStage::Review) => vec![
            WorkStage::Planning,
            WorkStage::Execution,
            WorkStage::Validation,
        ],
        Some(WorkStage::Validation) => vec![
            WorkStage::Planning,
            WorkStage::Execution,
            WorkStage::Review,
            WorkStage::Reporting,
        ],
        Some(WorkStage::Reporting) => vec![WorkStage::Validation],
    }
}

pub(crate) fn disposition_material_fingerprint(work: &WorkView) -> Result<String, BtccError> {
    let action_progress = |actions: &[ActionProgress]| {
        actions
            .iter()
            .map(|action| {
                json!({
                    "actionKey": action.action_key,
                    "status": action_status_name(action.status),
                    "note": action.note,
                })
            })
            .collect::<Vec<_>>()
    };
    let review = |review: Option<&WorkReview>| {
        review.map_or(Value::Null, |review| {
            json!({
                "reviewRevisionId": review.review_revision_id,
                "revision": review.revision,
                "verdict": verdict_name(review.verdict),
                "boundPlanRevisionId": review.bound_plan_revision_id,
                "boundResultReviewRevisionId": review.bound_result_review_revision_id,
                "boundActionProgress": review.bound_action_progress.as_deref().map(action_progress),
                "boundResultRefs": review.bound_result_refs,
            })
        })
    };
    let snapshot = json!({
        "workId": work.work_id,
        "status": work_status_name(work.status),
        "currentPlan": work.current_plan.as_ref().map(|plan| json!({
            "planRevisionId": plan.plan_revision_id,
            "revision": plan.revision,
        })),
        "actionProgress": action_progress(&work.action_progress),
        "latestCheckpoint": work.latest_checkpoint.as_ref().map(|checkpoint| json!({
            "revision": checkpoint.revision,
            "planRevisionId": checkpoint.plan_revision_id,
            "stage": stage_name(checkpoint.stage),
            "actionProgress": action_progress(&checkpoint.action_progress),
            "resultSequence": checkpoint.referenced_result_refs.len(),
            "referencedResultRefs": checkpoint.referenced_result_refs,
        })),
        "reviews": [
            review(work.latest_plan_review.as_ref()),
            review(work.latest_result_review.as_ref()),
            review(work.latest_completion_validation.as_ref()),
        ],
        "resultRefs": work.result_refs.iter().map(|result| json!({
            "resultRef": result.result_ref,
            "toolCallId": result.tool_call_id,
            "status": result.status,
            "originTurnId": result.origin_turn_id,
        })).collect::<Vec<_>>(),
        "effectWatermark": work.effect_watermark,
        "effectBlockers": work.effect_blockers.as_deref().unwrap_or(&[]).iter().map(|blocker| json!({
            "blockerId": blocker.blocker_id,
            "sourceTurnId": blocker.source_turn_id,
            "capability": blocker.capability,
            "target": blocker.target,
            "detail": blocker.detail,
        })).collect::<Vec<_>>(),
    });
    let stable = crate::btcc::identity::stable_json(&snapshot)?;
    Ok(crate::btcc::identity::digest(&stable))
}

fn review_target_stage(
    subject: ReviewSubject,
    verdict: ReviewVerdict,
    correction_scope: Option<CorrectionScope>,
) -> Result<WorkStage, BtccError> {
    if verdict == ReviewVerdict::Accept {
        return Ok(match subject {
            ReviewSubject::Plan => WorkStage::Execution,
            ReviewSubject::Result => WorkStage::Validation,
            ReviewSubject::Completion => WorkStage::Reporting,
        });
    }
    if subject == ReviewSubject::Plan {
        return Ok(WorkStage::Planning);
    }
    correction_scope.map_or_else(
        || {
            Err(error(format!(
                "Work {} {} requires correctionScope",
                subject_name(subject),
                verdict_name(verdict)
            )))
        },
        |scope| {
            Ok(match scope {
                CorrectionScope::Planning => WorkStage::Planning,
                CorrectionScope::Execution => WorkStage::Execution,
            })
        },
    )
}

fn review_entry_stages(subject: ReviewSubject) -> &'static [WorkStage] {
    match subject {
        ReviewSubject::Plan => &[WorkStage::Planning, WorkStage::Execution, WorkStage::Review],
        ReviewSubject::Result => &[WorkStage::Execution, WorkStage::Review],
        ReviewSubject::Completion => &[
            WorkStage::Review,
            WorkStage::Validation,
            WorkStage::Reporting,
        ],
    }
}

fn assert_stage_transition(current: WorkStage, attempted: WorkStage) -> Result<(), BtccError> {
    if current == attempted || allowed_next_work_stages(Some(current)).contains(&attempted) {
        return Ok(());
    }
    Err(BtccError::new(
        "invalid_work_stage_transition",
        format!(
            "Work cannot move from {} to {}; allowed next stages: {}",
            stage_name(current),
            stage_name(attempted),
            allowed_next_work_stages(Some(current))
                .iter()
                .map(|stage| stage_name(*stage))
                .collect::<Vec<_>>()
                .join(", "),
        ),
    ))
}

fn review_guard(stage: WorkStage) -> &'static str {
    match stage {
        WorkStage::Conception => "current_plan_missing",
        WorkStage::Planning => "plan_review_required",
        WorkStage::Execution => "result_review_required",
        WorkStage::Review => "current_review_incomplete",
        WorkStage::Validation | WorkStage::Reporting => "completion_review_required",
    }
}

fn review_next_action(stage: WorkStage) -> &'static str {
    match stage {
        WorkStage::Conception => "replace_work_plan",
        WorkStage::Planning => "record_plan_review",
        WorkStage::Execution | WorkStage::Review => "record_result_review",
        WorkStage::Validation | WorkStage::Reporting => "record_completion_review",
    }
}

fn guard_error(current: WorkStage, requested: &str, unmet: &str, next: &str) -> BtccError {
    BtccError::new(
        "work_transition_guard_unmet",
        format!(
            "Work cannot {requested} from {}; {unmet}. Next action: {next}",
            stage_name(current)
        ),
    )
}

fn stage_name(stage: WorkStage) -> &'static str {
    match stage {
        WorkStage::Conception => "conception",
        WorkStage::Planning => "planning",
        WorkStage::Execution => "execution",
        WorkStage::Review => "review",
        WorkStage::Validation => "validation",
        WorkStage::Reporting => "reporting",
    }
}

fn subject_name(subject: ReviewSubject) -> &'static str {
    match subject {
        ReviewSubject::Plan => "plan",
        ReviewSubject::Result => "result",
        ReviewSubject::Completion => "completion",
    }
}

fn verdict_name(verdict: ReviewVerdict) -> &'static str {
    match verdict {
        ReviewVerdict::Accept => "accept",
        ReviewVerdict::Revise => "revise",
        ReviewVerdict::Partial => "partial",
    }
}

fn action_status_name(status: ActionStatus) -> &'static str {
    match status {
        ActionStatus::Pending => "pending",
        ActionStatus::Active => "active",
        ActionStatus::Done => "done",
        ActionStatus::Blocked => "blocked",
        ActionStatus::Skipped => "skipped",
    }
}

fn work_status_name(status: WorkStatus) -> &'static str {
    match status {
        WorkStatus::Open => "open",
        WorkStatus::Blocked => "blocked",
        WorkStatus::Completed => "completed",
        WorkStatus::Abandoned => "abandoned",
    }
}

fn error(message: impl Into<String>) -> BtccError {
    BtccError::new("durable_work_policy", message)
}

#[cfg(test)]
mod tests;
