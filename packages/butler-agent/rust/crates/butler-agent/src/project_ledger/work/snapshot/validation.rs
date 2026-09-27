use std::collections::{HashMap, HashSet};

use serde_json::Value;

use crate::btcc::{BtccError, ProjectWorkMaterialSnapshot, WorkView};

use super::super::{codec, invalid};

pub(super) fn pointers(
    manifest: &Value,
    children: &HashMap<String, Value>,
    view: &WorkView,
) -> Result<(), BtccError> {
    let failure = || invalid("project_work_managed_record_invalid");
    let child = |pointer: &str| -> Result<Option<&Value>, BtccError> {
        manifest
            .get(pointer)
            .and_then(Value::as_str)
            .map(|id| children.get(id).ok_or_else(failure))
            .transpose()
    };
    let plan = child("currentPlanRevisionId")?;
    if let Some(plan) = plan {
        let plan_value = required(plan, "plan")?;
        let actions = array(plan_value, "actions")?;
        let keys = actions
            .iter()
            .map(|action| text(action, "actionKey"))
            .collect::<Result<Vec<_>, _>>()?;
        let progress = array(manifest, "actionProgress")?;
        if plan_value.get("revision") != manifest.get("planRevision")
            || plan_value.get("objective") != manifest.get("objective")
            || keys.len() != progress.len()
            || keys.iter().copied().collect::<HashSet<_>>().len() != keys.len()
            || keys
                .iter()
                .zip(progress)
                .any(|(key, item)| item.get("actionKey").and_then(Value::as_str) != Some(*key))
        {
            return Err(failure());
        }
        plan_identity(plan)?;
    } else if manifest.get("planRevision").and_then(Value::as_u64) != Some(0) {
        return Err(failure());
    }
    if let Some(checkpoint) = child("latestCheckpointRevisionId")? {
        let item = required(checkpoint, "checkpoint")?;
        let window = required(checkpoint, "resultWindow")?;
        let end = usize::try_from(number(window, "toSequence")?).unwrap_or(usize::MAX);
        let refs = array(manifest, "resultRefs")?;
        let mentioned = array(item, "referencedResultRefs")?;
        if item.get("revision") != manifest.get("checkpointRevision")
            || window.get("fromSequence").and_then(Value::as_u64) != Some(0)
            || window.get("toSequence") != manifest.get("checkpointResultSequence")
            || item.get("planRevisionId") != manifest.get("currentPlanRevisionId")
            || item.get("stage") != manifest.get("currentStage")
            || item.get("actionProgress") != manifest.get("actionProgress")
            || end > refs.len()
            || mentioned.len() != end
            || refs[..end]
                .iter()
                .zip(mentioned)
                .any(|(left, right)| left.get("resultRef") != Some(right))
            || mentioned
                .iter()
                .filter_map(Value::as_str)
                .collect::<HashSet<_>>()
                .len()
                != mentioned.len()
        {
            return Err(failure());
        }
        let plan_id = text(item, "planRevisionId")?;
        plan_identity(children.get(plan_id).ok_or_else(failure)?)?;
    }
    let review_keys = [
        ("latestPlanReviewRevisionId", "plan"),
        ("latestResultReviewRevisionId", "result"),
        ("latestCompletionValidationRevisionId", "completion"),
    ];
    let mut revisions = HashSet::new();
    for (pointer, subject) in review_keys {
        let Some(review) = child(pointer)? else {
            continue;
        };
        let value = required(review, "review")?;
        let revision = number(value, "revision")?;
        if !revisions.insert(revision) || revision > number(manifest, "reviewRevision")? {
            return Err(failure());
        }
        validate_review(review, subject, manifest, children)?;
    }
    if let Some(completion) = child("latestCompletionValidationRevisionId")? {
        let review = required(completion, "review")?;
        if child("latestDispositionRevisionId")?.is_none()
            && completion.get("operationIdentity") == manifest.get("operationIdentity")
            && ((review.get("verdict").and_then(Value::as_str) == Some("accept")
                && manifest.get("currentStage").and_then(Value::as_str) != Some("reporting"))
                || (review.get("verdict").and_then(Value::as_str) != Some("accept")
                    && !matches!(
                        manifest.get("currentStage").and_then(Value::as_str),
                        Some("planning" | "execution")
                    ))
                || review.get("boundActionProgress") != manifest.get("actionProgress"))
        {
            return Err(failure());
        }
    }
    if let Some(disposition) = child("latestDispositionRevisionId")? {
        let item = required(disposition, "disposition")?;
        let material = required(disposition, "materialSnapshot")?;
        if item.get("revision") != manifest.get("dispositionRevision")
            || material.get("materialFingerprint") != item.get("materialFingerprint")
            || material.get("workId") != manifest.get("workId")
            || material.get("status") != item.get("disposition")
            || array(material, "resultRefs")?.len() as u64 != number(item, "resultSequence")?
        {
            return Err(failure());
        }
        if disposition
            .pointer("/operationIdentity/kind")
            .and_then(Value::as_str)
            == Some("mutation_call")
        {
            let id = text(required(disposition, "operationIdentity")?, "id")?;
            if text(item, "dispositionRevisionId")? != codec::record_id("disposition", id) {
                return Err(failure());
            }
        }
    }
    for (index, reference) in array(manifest, "resultRefs")?.iter().enumerate() {
        let id = text(reference, "resultRef")?;
        let result = children.get(id).ok_or_else(failure)?;
        let item = required(result, "result")?;
        let mut bare = item.as_object().ok_or_else(failure)?.clone();
        bare.remove("sequence");
        if item.get("sequence").and_then(Value::as_u64) != Some(index as u64 + 1)
            || id != codec::record_id("result", text(item, "toolCallId")?).as_str()
            || result.get("sessionId") != manifest.get("sessionId")
            || result.get("scope") != manifest.get("scope")
            || !array(manifest, "bindingRefs")?
                .iter()
                .any(|binding| binding.get("turnId") == item.get("originTurnId"))
            || Value::Object(bare) != *reference
        {
            return Err(failure());
        }
    }
    let material: ProjectWorkMaterialSnapshot =
        codec::typed(required(manifest, "materialSnapshot")?.clone())?;
    if material.material_fingerprint != text(manifest, "materialFingerprint")? {
        return Err(failure());
    }
    let expected = crate::btcc::build_project_work_material_snapshot(
        view,
        material.material_fingerprint.clone(),
        material.effect_watermark.clone(),
        material.effect_blockers.clone(),
    )?;
    if material != expected {
        return Err(failure());
    }
    Ok(())
}

fn validate_review(
    child: &Value,
    subject: &str,
    manifest: &Value,
    children: &HashMap<String, Value>,
) -> Result<(), BtccError> {
    let failure = || invalid("project_work_managed_record_invalid");
    let review = required(child, "review")?;
    let refs = array(review, "boundResultRefs")?;
    let sequence = usize::try_from(number(child, "boundResultSequence")?).unwrap_or(usize::MAX);
    if text(review, "subject")? != subject
        || (subject == "plan"
            && review
                .get("boundPlanRevisionId")
                .and_then(Value::as_str)
                .is_none())
        || (subject == "result" && review.get("boundPlanRevisionId").is_some())
        || (subject == "plan" && !refs.is_empty())
        || (subject == "completion"
            && review
                .get("boundResultReviewRevisionId")
                .and_then(Value::as_str)
                .is_none())
        || (subject != "completion" && review.get("boundResultReviewRevisionId").is_some())
    {
        return Err(failure());
    }
    if child
        .pointer("/operationIdentity/kind")
        .and_then(Value::as_str)
        == Some("mutation_call")
    {
        let id = text(required(child, "operationIdentity")?, "id")?;
        if text(review, "reviewRevisionId")? != codec::record_id("review", id) {
            return Err(failure());
        }
    }
    if let Some(id) = review.get("boundPlanRevisionId").and_then(Value::as_str) {
        plan_identity(children.get(id).ok_or_else(failure)?)?;
    }
    let result_refs = array(manifest, "resultRefs")?;
    if subject != "plan" && (refs.len() != sequence || review.get("boundActionProgress").is_none())
    {
        return Err(failure());
    }
    if subject != "plan"
        && (sequence > result_refs.len()
            || refs
                .iter()
                .zip(&result_refs[..sequence])
                .any(|(id, result)| result.get("resultRef") != Some(id)))
    {
        return Err(failure());
    }
    if let Some(id) = review
        .get("boundResultReviewRevisionId")
        .and_then(Value::as_str)
    {
        let bound = children.get(id).ok_or_else(failure)?;
        let prior = required(bound, "review")?;
        if prior.get("subject").and_then(Value::as_str) != Some("result")
            || prior.get("verdict").and_then(Value::as_str) != Some("accept")
            || number(prior, "revision")? >= number(review, "revision")?
            || bound.get("boundResultSequence") != child.get("boundResultSequence")
            || prior.get("boundResultRefs") != review.get("boundResultRefs")
            || !same_action_keys(
                prior.get("boundActionProgress"),
                review.get("boundActionProgress"),
            )
        {
            return Err(failure());
        }
        validate_review(bound, "result", manifest, children)?;
    }
    Ok(())
}

fn plan_identity(plan: &Value) -> Result<(), BtccError> {
    let failure = || invalid("project_work_managed_record_invalid");
    let identity = required(plan, "operationIdentity")?;
    if identity.get("kind").and_then(Value::as_str) == Some("mutation_call") {
        let id = text(identity, "id")?;
        if identity.get("mutationCallId").and_then(Value::as_str) != Some(id)
            || text(required(plan, "plan")?, "planRevisionId")? != codec::record_id("plan", id)
        {
            return Err(failure());
        }
    }
    Ok(())
}

fn same_action_keys(left: Option<&Value>, right: Option<&Value>) -> bool {
    let (Some(left), Some(right)) = (
        left.and_then(Value::as_array),
        right.and_then(Value::as_array),
    ) else {
        return false;
    };
    left.len() == right.len()
        && left
            .iter()
            .zip(right)
            .all(|(a, b)| a.get("actionKey") == b.get("actionKey"))
}

fn required<'a>(value: &'a Value, key: &str) -> Result<&'a Value, BtccError> {
    value
        .get(key)
        .ok_or_else(|| invalid("project_work_managed_record_invalid"))
}
fn text<'a>(value: &'a Value, key: &str) -> Result<&'a str, BtccError> {
    value
        .get(key)
        .and_then(Value::as_str)
        .ok_or_else(|| invalid("project_work_managed_record_invalid"))
}
fn number(value: &Value, key: &str) -> Result<u64, BtccError> {
    value
        .get(key)
        .and_then(Value::as_u64)
        .ok_or_else(|| invalid("project_work_managed_record_invalid"))
}
fn array<'a>(value: &'a Value, key: &str) -> Result<&'a [Value], BtccError> {
    value
        .get(key)
        .and_then(Value::as_array)
        .map(Vec::as_slice)
        .ok_or_else(|| invalid("project_work_managed_record_invalid"))
}
