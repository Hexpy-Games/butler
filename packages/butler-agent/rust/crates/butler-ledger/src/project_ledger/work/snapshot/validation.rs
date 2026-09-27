use std::collections::{HashMap, HashSet};

use serde_json::Value;

use butler_turn::btcc::{BtccError, ProjectWorkMaterialSnapshot, WorkView};

use super::super::{codec, invalid};

/// Every child the manifest points at exists and agrees with it: the current
/// plan, latest checkpoint, reviews, disposition and results, and finally the
/// material snapshot rebuilt from `view`.
pub(super) fn pointers(
    manifest: &Value,
    children: &HashMap<String, Value>,
    view: &WorkView,
) -> Result<(), BtccError> {
    let pointers = Pointers { manifest, children };
    pointers.current_plan()?;
    if let Some(checkpoint) = pointers.child("latestCheckpointRevisionId")? {
        pointers.checkpoint(checkpoint)?;
    }
    pointers.reviews()?;
    if let Some(completion) = pointers.child("latestCompletionValidationRevisionId")? {
        pointers.completion(completion)?;
    }
    if let Some(disposition) = pointers.child("latestDispositionRevisionId")? {
        pointers.disposition(disposition)?;
    }
    pointers.results()?;
    material(manifest, view)
}

struct Pointers<'a> {
    manifest: &'a Value,
    children: &'a HashMap<String, Value>,
}

fn failure() -> BtccError {
    invalid("project_work_managed_record_invalid")
}

impl<'a> Pointers<'a> {
    /// The child a manifest pointer names; it must exist when named.
    fn child(&self, pointer: &str) -> Result<Option<&'a Value>, BtccError> {
        self.manifest
            .get(pointer)
            .and_then(Value::as_str)
            .map(|id| self.children.get(id).ok_or_else(failure))
            .transpose()
    }

    /// The current plan matches the manifest's revision, objective and
    /// progress keys; without one the plan revision is zero.
    fn current_plan(&self) -> Result<(), BtccError> {
        let manifest = self.manifest;
        let Some(plan) = self.child("currentPlanRevisionId")? else {
            if manifest.get("planRevision").and_then(Value::as_u64) != Some(0) {
                return Err(failure());
            }
            return Ok(());
        };
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
        plan_identity(plan)
    }

    /// The latest checkpoint's revision, result window and progress match.
    fn checkpoint(&self, checkpoint: &Value) -> Result<(), BtccError> {
        let manifest = self.manifest;
        let item = required(checkpoint, "checkpoint")?;
        let window = required(checkpoint, "resultWindow")?;
        let end = usize::try_from(number(window, "toSequence")?).unwrap_or(usize::MAX);
        let refs = array(manifest, "resultRefs")?;
        let mentioned = array(item, "referencedResultRefs")?;
        let Some(prefix) = refs.get(..end) else {
            return Err(failure());
        };
        if item.get("revision") != manifest.get("checkpointRevision")
            || window.get("fromSequence").and_then(Value::as_u64) != Some(0)
            || window.get("toSequence") != manifest.get("checkpointResultSequence")
            || item.get("planRevisionId") != manifest.get("currentPlanRevisionId")
            || item.get("stage") != manifest.get("currentStage")
            || item.get("actionProgress") != manifest.get("actionProgress")
            || mentioned.len() != end
            || prefix
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
        plan_identity(self.children.get(plan_id).ok_or_else(failure)?)
    }

    /// Latest reviews have unique, current revisions and valid bindings.
    fn reviews(&self) -> Result<(), BtccError> {
        let review_keys = [
            ("latestPlanReviewRevisionId", "plan"),
            ("latestResultReviewRevisionId", "result"),
            ("latestCompletionValidationRevisionId", "completion"),
        ];
        let mut revisions = HashSet::new();
        for (pointer, subject) in review_keys {
            let Some(review) = self.child(pointer)? else {
                continue;
            };
            let revision = number(required(review, "review")?, "revision")?;
            if !revisions.insert(revision) || revision > number(self.manifest, "reviewRevision")? {
                return Err(failure());
            }
            validate_review(review, subject, self.manifest, self.children)?;
        }
        Ok(())
    }

    /// An undisposed completion validation of this operation left the Work
    /// in the stage its verdict leads to, with the progress it validated.
    fn completion(&self, completion: &Value) -> Result<(), BtccError> {
        let manifest = self.manifest;
        let review = required(completion, "review")?;
        let stage = manifest.get("currentStage").and_then(Value::as_str);
        let accepted = review.get("verdict").and_then(Value::as_str) == Some("accept");
        let stage_mismatch = if accepted {
            stage != Some("reporting")
        } else {
            !matches!(stage, Some("planning" | "execution"))
        };
        if self.child("latestDispositionRevisionId")?.is_none()
            && completion.get("operationIdentity") == manifest.get("operationIdentity")
            && (stage_mismatch
                || review.get("boundActionProgress") != manifest.get("actionProgress"))
        {
            return Err(failure());
        }
        Ok(())
    }

    /// The latest disposition matches the manifest and its material snapshot.
    fn disposition(&self, disposition: &Value) -> Result<(), BtccError> {
        let manifest = self.manifest;
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
            != Some("mutation_call")
        {
            return Ok(());
        }
        let id = text(required(disposition, "operationIdentity")?, "id")?;
        if text(item, "dispositionRevisionId")? != codec::record_id("disposition", id) {
            return Err(failure());
        }
        Ok(())
    }

    /// Every result reference is its child's result without the sequence,
    /// in order, from a bound turn.
    fn results(&self) -> Result<(), BtccError> {
        let manifest = self.manifest;
        for (sequence, reference) in (1_u64..).zip(array(manifest, "resultRefs")?) {
            let id = text(reference, "resultRef")?;
            let result = self.children.get(id).ok_or_else(failure)?;
            let item = required(result, "result")?;
            let mut bare = item.as_object().ok_or_else(failure)?.clone();
            bare.remove("sequence");
            if item.get("sequence").and_then(Value::as_u64) != Some(sequence)
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
        Ok(())
    }
}

/// The stored material snapshot equals the one rebuilt from `view`.
fn material(manifest: &Value, view: &WorkView) -> Result<(), BtccError> {
    let material: ProjectWorkMaterialSnapshot =
        codec::typed(required(manifest, "materialSnapshot")?.clone())?;
    if material.material_fingerprint != text(manifest, "materialFingerprint")? {
        return Err(failure());
    }
    let expected = butler_turn::btcc::build_project_work_material_snapshot(
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
        && result_refs.get(..sequence).is_none_or(|bound| {
            refs.iter()
                .zip(bound)
                .any(|(id, result)| result.get("resultRef") != Some(id))
        })
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
