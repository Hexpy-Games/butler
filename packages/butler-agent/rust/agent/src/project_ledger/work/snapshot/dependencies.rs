use std::collections::{HashMap, HashSet};

use serde_json::Value;

use crate::btcc::BtccError;

use super::super::invalid;

pub(super) fn refs(
    manifest: &Value,
    children: &HashMap<String, Value>,
) -> Result<Vec<(String, &'static str, &'static str)>, BtccError> {
    let mut refs = Vec::new();
    let mut seen = HashSet::new();
    let mut add = |id: &str, kind, schema| {
        if seen.insert((kind, id.to_owned())) {
            refs.push((id.to_owned(), kind, schema));
        }
    };
    if let Some(checkpoint_id) = manifest
        .get("latestCheckpointRevisionId")
        .and_then(Value::as_str)
    {
        let checkpoint = children
            .get(checkpoint_id)
            .and_then(|child| child.get("checkpoint"))
            .ok_or_else(managed_invalid)?;
        add(
            required(checkpoint, "planRevisionId")?,
            "plan",
            "butler.btcc-project-work-plan.v1",
        );
    }
    for pointer in [
        "latestPlanReviewRevisionId",
        "latestResultReviewRevisionId",
        "latestCompletionValidationRevisionId",
    ] {
        let Some(id) = manifest.get(pointer).and_then(Value::as_str) else {
            continue;
        };
        let review = children
            .get(id)
            .and_then(|child| child.get("review"))
            .ok_or_else(managed_invalid)?;
        if let Some(plan) = review.get("boundPlanRevisionId").and_then(Value::as_str) {
            add(plan, "plan", "butler.btcc-project-work-plan.v1");
        }
        if let Some(bound) = review
            .get("boundResultReviewRevisionId")
            .and_then(Value::as_str)
        {
            add(bound, "reference", "butler.btcc-project-work-review.v1");
        }
        for result in review
            .get("boundResultRefs")
            .and_then(Value::as_array)
            .ok_or_else(managed_invalid)?
        {
            add(
                result.as_str().ok_or_else(managed_invalid)?,
                "reference",
                "butler.btcc-project-work-result-reference.v1",
            );
        }
    }
    Ok(refs)
}

fn required<'a>(value: &'a Value, key: &str) -> Result<&'a str, BtccError> {
    value
        .get(key)
        .and_then(Value::as_str)
        .ok_or_else(managed_invalid)
}

fn managed_invalid() -> BtccError {
    invalid("project_work_managed_record_invalid")
}
