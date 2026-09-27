use std::collections::HashSet;

use serde_json::Value;
use sha2::{Digest, Sha256};

use super::super::{invalid, required_string};
use crate::project_ledger::ProjectLedgerReadError;

/// The relations between the manifest and its current children: allowed
/// stages, plan actions, checkpoint and review result windows, the
/// disposition material, and every id derived from its operation identity.
pub(super) fn validate(
    manifest: &Value,
    plan: Option<&Value>,
    checkpoint: Option<&Value>,
    reviews: &[Option<Value>; 3],
    disposition: Option<&Value>,
) -> Result<(), ProjectLedgerReadError> {
    allowed_next_stages(manifest)?;
    if let Some(plan) = plan {
        plan_actions(manifest, plan)?;
    }
    let result_refs = manifest
        .get("resultRefs")
        .and_then(Value::as_array)
        .ok_or_else(invalid)?;
    if let Some(checkpoint) = checkpoint {
        checkpoint_window(manifest, checkpoint, result_refs)?;
    }
    let mut review_revisions = HashSet::new();
    for (slot, child) in ReviewSlot::ALL.into_iter().zip(reviews) {
        let Some(child) = child else { continue };
        review_window(manifest, slot, child, result_refs, &mut review_revisions)?;
    }
    if let Some(disposition) = disposition {
        disposition_material(manifest, disposition)?;
    }
    for result in result_refs {
        let expected = record_id("result", required_string(result, "toolCallId")?);
        if result.get("resultRef").and_then(Value::as_str) != Some(expected.as_str()) {
            return Err(invalid());
        }
    }
    Ok(())
}

/// Which latest review a child is, in the manifest's order.
#[derive(Clone, Copy)]
enum ReviewSlot {
    Plan,
    Result,
    Completion,
}

impl ReviewSlot {
    const ALL: [Self; 3] = [Self::Plan, Self::Result, Self::Completion];

    /// Whether the review carries exactly the bindings its subject needs.
    fn bindings_valid(self, review: &Value, bound: &[Value]) -> bool {
        match self {
            Self::Plan => {
                review
                    .get("boundPlanRevisionId")
                    .and_then(Value::as_str)
                    .is_some()
                    && bound.is_empty()
                    && review.get("boundResultReviewRevisionId").is_none()
            }
            Self::Result => {
                review.get("boundPlanRevisionId").is_none()
                    && review.get("boundResultReviewRevisionId").is_none()
                    && review.get("boundActionProgress").is_some()
            }
            Self::Completion => {
                review
                    .get("boundResultReviewRevisionId")
                    .and_then(Value::as_str)
                    .is_some()
                    && review.get("boundActionProgress").is_some()
            }
        }
    }
}

fn allowed_next_stages(manifest: &Value) -> Result<(), ProjectLedgerReadError> {
    let allowed = match manifest.get("currentStage").and_then(Value::as_str) {
        None => &["conception"][..],
        Some("conception") => &["planning"],
        Some("planning" | "execution") => &["review"],
        Some("review") => &["planning", "execution", "validation"],
        Some("validation") => &["planning", "execution", "review", "reporting"],
        Some("reporting") => &["validation"],
        _ => return Err(invalid()),
    };
    let actual = manifest
        .get("allowedNextStages")
        .and_then(Value::as_array)
        .ok_or_else(invalid)?;
    if actual
        .iter()
        .map(Value::as_str)
        .collect::<Option<Vec<_>>>()
        .as_deref()
        != Some(allowed)
    {
        return Err(invalid());
    }
    Ok(())
}

/// Plan actions line up with the manifest's progress, keys are unique and
/// dependencies name other actions of the plan.
fn plan_actions(manifest: &Value, plan: &Value) -> Result<(), ProjectLedgerReadError> {
    let item = plan.get("plan").ok_or_else(invalid)?;
    let actions = item
        .get("actions")
        .and_then(Value::as_array)
        .ok_or_else(invalid)?;
    let progress = manifest
        .get("actionProgress")
        .and_then(Value::as_array)
        .ok_or_else(invalid)?;
    if actions.len() != progress.len() || item.get("revision") != manifest.get("planRevision") {
        return Err(invalid());
    }
    let keys = actions
        .iter()
        .map(|action| required_string(action, "actionKey"))
        .collect::<Result<Vec<_>, _>>()?;
    if keys.iter().copied().collect::<HashSet<_>>().len() != keys.len()
        || keys
            .iter()
            .zip(progress)
            .any(|(key, progress)| progress.get("actionKey").and_then(Value::as_str) != Some(*key))
    {
        return Err(invalid());
    }
    for action in actions {
        let key = required_string(action, "actionKey")?;
        let dependencies = action
            .get("dependencyKeys")
            .and_then(Value::as_array)
            .ok_or_else(invalid)?;
        if dependencies.iter().any(|dependency| {
            dependency
                .as_str()
                .is_none_or(|name| name == key || !keys.contains(&name))
        }) {
            return Err(invalid());
        }
    }
    validate_record_id(plan, "plan", required_string(item, "planRevisionId")?)
}

/// `refs[..end]` names exactly `mentioned`, or `None` past the end.
fn window_matches(refs: &[Value], end: u64, mentioned: &[Value]) -> bool {
    let end = usize::try_from(end).unwrap_or(usize::MAX);
    refs.get(..end).is_some_and(|window| {
        mentioned.len() == end
            && window
                .iter()
                .zip(mentioned)
                .all(|(source, mentioned)| source.get("resultRef") == Some(mentioned))
    })
}

/// The checkpoint's result window and progress match the manifest and its
/// id derives from its operation identity.
fn checkpoint_window(
    manifest: &Value,
    checkpoint: &Value,
    result_refs: &[Value],
) -> Result<(), ProjectLedgerReadError> {
    let item = checkpoint.get("checkpoint").ok_or_else(invalid)?;
    let end = checkpoint
        .pointer("/resultWindow/toSequence")
        .and_then(Value::as_u64)
        .ok_or_else(invalid)?;
    let mentioned = item
        .get("referencedResultRefs")
        .and_then(Value::as_array)
        .ok_or_else(invalid)?;
    if !window_matches(result_refs, end, mentioned)
        || item.get("actionProgress") != manifest.get("actionProgress")
    {
        return Err(invalid());
    }
    let identity = checkpoint.get("operationIdentity").ok_or_else(invalid)?;
    if identity.get("kind").and_then(Value::as_str) == Some("legacy_import") {
        return Ok(());
    }
    let id = required_string(identity, "id")?;
    let checkpoint_identity = required_string(checkpoint, "checkpointIdentity")?;
    let suffix = checkpoint_identity.strip_prefix(id).unwrap_or("");
    if checkpoint_identity != id
        && !matches!(
            suffix,
            "\0conception"
                | "\0plan"
                | "\0review-entry"
                | "\0review-exit"
                | "\0validation-entry"
                | "\0validation-exit"
                | "\0disposition"
        )
    {
        return Err(invalid());
    }
    let expected = record_id("checkpoint", checkpoint_identity);
    if item.get("checkpointRevisionId").and_then(Value::as_str) != Some(expected.as_str()) {
        return Err(invalid());
    }
    Ok(())
}

/// A review's revision is unique and current, its bound result window
/// matches, and it carries the bindings of its subject.
fn review_window(
    manifest: &Value,
    slot: ReviewSlot,
    child: &Value,
    result_refs: &[Value],
    revisions: &mut HashSet<u64>,
) -> Result<(), ProjectLedgerReadError> {
    let review = child.get("review").ok_or_else(invalid)?;
    let revision = review
        .get("revision")
        .and_then(Value::as_u64)
        .ok_or_else(invalid)?;
    if !revisions.insert(revision)
        || revision
            > manifest
                .get("reviewRevision")
                .and_then(Value::as_u64)
                .ok_or_else(invalid)?
    {
        return Err(invalid());
    }
    let sequence = child
        .get("boundResultSequence")
        .and_then(Value::as_u64)
        .ok_or_else(invalid)?;
    let bound = review
        .get("boundResultRefs")
        .and_then(Value::as_array)
        .ok_or_else(invalid)?;
    if !window_matches(result_refs, sequence, bound) || !slot.bindings_valid(review, bound) {
        return Err(invalid());
    }
    validate_record_id(
        child,
        "review",
        required_string(review, "reviewRevisionId")?,
    )
}

/// The disposition's material snapshot describes this Work and disposition.
fn disposition_material(
    manifest: &Value,
    disposition: &Value,
) -> Result<(), ProjectLedgerReadError> {
    let item = disposition.get("disposition").ok_or_else(invalid)?;
    let material = disposition.get("materialSnapshot").ok_or_else(invalid)?;
    if material.get("workId") != manifest.get("workId")
        || material.get("materialFingerprint") != item.get("materialFingerprint")
        || material.get("status") != item.get("disposition")
        || material
            .get("resultRefs")
            .and_then(Value::as_array)
            .map(Vec::len)
            != item
                .get("resultSequence")
                .and_then(Value::as_u64)
                .map(|n| usize::try_from(n).unwrap_or(usize::MAX))
    {
        return Err(invalid());
    }
    validate_record_id(
        disposition,
        "disposition",
        required_string(item, "dispositionRevisionId")?,
    )
}

pub(super) fn binding_id(turn_id: &str, revision: u64, work_id: &str) -> String {
    record_id("binding", &format!("{turn_id}\0{revision}\0{work_id}"))
}

fn validate_record_id(child: &Value, kind: &str, id: &str) -> Result<(), ProjectLedgerReadError> {
    let identity = child.get("operationIdentity").ok_or_else(invalid)?;
    if identity.get("kind").and_then(Value::as_str) == Some("mutation_call")
        && id != record_id(kind, required_string(identity, "id")?)
    {
        return Err(invalid());
    }
    Ok(())
}

fn record_id(kind: &str, identity: &str) -> String {
    let digest = Sha256::digest(format!("btcc-guided-work.v1\0{kind}\0{identity}").as_bytes());
    format!("guided-{kind}-{digest:x}")
}
