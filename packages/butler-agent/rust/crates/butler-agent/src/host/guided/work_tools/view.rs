//! The source's compact success view and richer current-Work error view.

use std::collections::HashMap;

use serde_json::{Value, json};

use crate::btcc::{
    ActionStatus, ReviewSubject, WorkStage, WorkView, accepted_current_result_review,
};

pub(super) fn success(work: &WorkView) -> Value {
    let unresolved = unresolved(work);
    let completion_blockers = blockers(work, &unresolved);
    let mut result = json!({
        "work_id":work.work_id,
        "status":work.status,
        "current_stage":work.current_stage,
        "execution_mode":work.current_plan.as_ref().and_then(|plan| plan.execution_mode),
        "actions":actions(work),
        "unresolved_action_keys":unresolved,
        "completion_blockers":completion_blockers,
        "latest_plan_review":work.latest_plan_review.as_ref().map(|review| review.verdict),
        "latest_result_review":work.latest_result_review.as_ref().map(|review| review.verdict),
        "latest_completion_validation":work.latest_completion_validation.as_ref().map(|review| review.verdict),
    });
    disposition(work, &mut result);
    result
}

pub(super) fn current(work: &WorkView) -> Value {
    let mut result = success(work);
    result["allowed_next_stages"] = json!(work.allowed_next_stages);
    result["available_review_subjects"] = json!(review_subjects(work));
    result["executable_action_keys"] = json!(executable(work));
    result
}

fn unresolved(work: &WorkView) -> Vec<&str> {
    work.action_progress
        .iter()
        .filter(|progress| !matches!(progress.status, ActionStatus::Done | ActionStatus::Skipped))
        .map(|progress| progress.action_key.as_str())
        .collect()
}

fn blockers(work: &WorkView, unresolved: &[&str]) -> Vec<&'static str> {
    let mut result = Vec::with_capacity(2);
    if !unresolved.is_empty() {
        result.push("unresolved_actions");
    }
    if work
        .effect_blockers
        .as_ref()
        .is_some_and(|items| !items.is_empty())
    {
        result.push("effect_reconciliation_required");
    }
    result
}

fn actions(work: &WorkView) -> Vec<Value> {
    let Some(plan) = &work.current_plan else {
        return Vec::new();
    };
    let progress: HashMap<&str, ActionStatus> = work
        .action_progress
        .iter()
        .map(|item| (item.action_key.as_str(), item.status))
        .collect();
    plan.actions
        .iter()
        .map(|action| {
            json!({"action_key":action.action_key,
                "status":progress.get(action.action_key.as_str()).copied().unwrap_or(ActionStatus::Pending)})
        })
        .collect()
}

fn disposition(work: &WorkView, result: &mut Value) {
    if let Some(value) = &work.latest_disposition {
        result["latest_disposition"] = json!({
            "disposition":value.disposition,
            "summary":value.summary,
            "remaining_actions":value.remaining_actions,
            "next_condition":value.next_condition,
        });
    }
}

fn review_subjects(work: &WorkView) -> Vec<ReviewSubject> {
    let Some(stage) = work.current_stage.filter(|_| work.current_plan.is_some()) else {
        return Vec::new();
    };
    [
        ReviewSubject::Plan,
        ReviewSubject::Result,
        ReviewSubject::Completion,
    ]
    .into_iter()
    .filter(|subject| match subject {
        ReviewSubject::Plan => matches!(
            stage,
            WorkStage::Planning | WorkStage::Execution | WorkStage::Review
        ),
        ReviewSubject::Result => matches!(stage, WorkStage::Execution | WorkStage::Review),
        ReviewSubject::Completion => {
            matches!(
                stage,
                WorkStage::Review | WorkStage::Validation | WorkStage::Reporting
            ) && accepted_current_result_review(work).is_some()
        }
    })
    .collect()
}

fn executable(work: &WorkView) -> Vec<&str> {
    let Some(plan) = &work.current_plan else {
        return Vec::new();
    };
    let progress: HashMap<&str, ActionStatus> = work
        .action_progress
        .iter()
        .map(|item| (item.action_key.as_str(), item.status))
        .collect();
    plan.actions
        .iter()
        .filter(|action| {
            let status = progress
                .get(action.action_key.as_str())
                .copied()
                .unwrap_or(ActionStatus::Pending);
            !matches!(
                status,
                ActionStatus::Done | ActionStatus::Skipped | ActionStatus::Blocked
            ) && action.dependency_keys.iter().all(|key| {
                progress.get(key.as_str()).is_some_and(|status| {
                    matches!(status, ActionStatus::Done | ActionStatus::Skipped)
                })
            })
        })
        .map(|action| action.action_key.as_str())
        .collect()
}
