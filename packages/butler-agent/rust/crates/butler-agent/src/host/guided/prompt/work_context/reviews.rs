use std::collections::HashSet;

use crate::btcc::WorkView;

pub(super) fn current_result_review(work: &WorkView) -> bool {
    let Some(review) = &work.latest_result_review else {
        return false;
    };
    let bound: HashSet<_> = review.bound_result_refs.iter().collect();
    bound.len() == work.result_refs.len()
        && work
            .result_refs
            .iter()
            .all(|result| bound.contains(&result.result_ref))
}

pub(super) fn current_completion_validation(work: &WorkView) -> bool {
    let Some(validation) = &work.latest_completion_validation else {
        return false;
    };
    let Some(result_review) = &work.latest_result_review else {
        return false;
    };
    validation.subject == crate::btcc::ReviewSubject::Completion
        && validation.bound_plan_revision_id.as_ref()
            == work
                .current_plan
                .as_ref()
                .map(|plan| &plan.plan_revision_id)
        && validation.bound_result_review_revision_id.as_ref()
            == Some(&result_review.review_revision_id)
        && validation.bound_action_progress.as_ref() == Some(&work.action_progress)
        && current_result_review(work)
        && {
            let bound: HashSet<_> = validation.bound_result_refs.iter().collect();
            bound.len() == work.result_refs.len()
                && work
                    .result_refs
                    .iter()
                    .all(|result| bound.contains(&result.result_ref))
        }
}

pub(super) fn available_reviews(work: &WorkView) -> String {
    let Some(stage) = work.current_stage else {
        return "none".into();
    };
    if work.current_plan.is_none() {
        return "none".into();
    }
    let mut available = Vec::new();
    match stage {
        crate::btcc::WorkStage::Planning
        | crate::btcc::WorkStage::Execution
        | crate::btcc::WorkStage::Review => available.push("plan"),
        _ => {}
    }
    if matches!(
        stage,
        crate::btcc::WorkStage::Execution | crate::btcc::WorkStage::Review
    ) {
        available.push("result");
    }
    if matches!(
        stage,
        crate::btcc::WorkStage::Review
            | crate::btcc::WorkStage::Validation
            | crate::btcc::WorkStage::Reporting
    ) && current_result_review(work)
        && work
            .latest_result_review
            .as_ref()
            .is_some_and(|review| super::word(&review.verdict) == "accept")
    {
        available.push("completion");
    }
    if available.is_empty() {
        "none".into()
    } else {
        available.join(", ")
    }
}
