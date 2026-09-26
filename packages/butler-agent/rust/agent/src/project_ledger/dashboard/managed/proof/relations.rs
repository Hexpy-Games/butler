use std::collections::HashSet;

use serde_json::Value;
use sha2::{Digest, Sha256};

use super::super::{invalid, required_string};
use crate::project_ledger::ProjectLedgerReadError;

pub(super) fn validate(
    manifest: &Value,
    plan: Option<&Value>,
    checkpoint: Option<&Value>,
    reviews: &[Option<Value>; 3],
    disposition: Option<&Value>,
) -> Result<(), ProjectLedgerReadError> {
    let stage = manifest.get("currentStage").and_then(Value::as_str);
    let allowed = match stage {
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
    if let Some(plan) = plan {
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
            || keys.iter().zip(progress).any(|(key, progress)| {
                progress.get("actionKey").and_then(Value::as_str) != Some(*key)
            })
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
        validate_record_id(plan, "plan", required_string(item, "planRevisionId")?)?;
    }
    if let Some(checkpoint) = checkpoint {
        let item = checkpoint.get("checkpoint").ok_or_else(invalid)?;
        let refs = manifest
            .get("resultRefs")
            .and_then(Value::as_array)
            .ok_or_else(invalid)?;
        let end = checkpoint
            .pointer("/resultWindow/toSequence")
            .and_then(Value::as_u64)
            .ok_or_else(invalid)? as usize;
        let mentioned = item
            .get("referencedResultRefs")
            .and_then(Value::as_array)
            .ok_or_else(invalid)?;
        if end > refs.len()
            || mentioned.len() != end
            || refs[..end]
                .iter()
                .zip(mentioned)
                .any(|(source, mentioned)| source.get("resultRef") != Some(mentioned))
            || item.get("actionProgress") != manifest.get("actionProgress")
        {
            return Err(invalid());
        }
        let identity = checkpoint.get("operationIdentity").ok_or_else(invalid)?;
        if identity.get("kind").and_then(Value::as_str) != Some("legacy_import") {
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
        }
    }
    let mut review_revisions = HashSet::new();
    let result_refs = manifest
        .get("resultRefs")
        .and_then(Value::as_array)
        .ok_or_else(invalid)?;
    for (index, child) in reviews.iter().enumerate() {
        let Some(child) = child else { continue };
        let review = child.get("review").ok_or_else(invalid)?;
        let revision = review
            .get("revision")
            .and_then(Value::as_u64)
            .ok_or_else(invalid)?;
        if !review_revisions.insert(revision)
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
            .ok_or_else(invalid)? as usize;
        let bound = review
            .get("boundResultRefs")
            .and_then(Value::as_array)
            .ok_or_else(invalid)?;
        if sequence > result_refs.len()
            || bound.len() != sequence
            || result_refs[..sequence]
                .iter()
                .zip(bound)
                .any(|(result, id)| result.get("resultRef") != Some(id))
        {
            return Err(invalid());
        }
        match index {
            0 if review
                .get("boundPlanRevisionId")
                .and_then(Value::as_str)
                .is_none()
                || !bound.is_empty()
                || review.get("boundResultReviewRevisionId").is_some() =>
            {
                return Err(invalid());
            }
            1 if review.get("boundPlanRevisionId").is_some()
                || review.get("boundResultReviewRevisionId").is_some()
                || review.get("boundActionProgress").is_none() =>
            {
                return Err(invalid());
            }
            2 if review
                .get("boundResultReviewRevisionId")
                .and_then(Value::as_str)
                .is_none()
                || review.get("boundActionProgress").is_none() =>
            {
                return Err(invalid());
            }
            _ => {}
        }
        validate_record_id(
            child,
            "review",
            required_string(review, "reviewRevisionId")?,
        )?;
    }
    if let Some(disposition) = disposition {
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
                    .map(|n| n as usize)
        {
            return Err(invalid());
        }
        validate_record_id(
            disposition,
            "disposition",
            required_string(item, "dispositionRevisionId")?,
        )?;
    }
    for result in result_refs {
        let expected = record_id("result", required_string(result, "toolCallId")?);
        if result.get("resultRef").and_then(Value::as_str) != Some(expected.as_str()) {
            return Err(invalid());
        }
    }
    Ok(())
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
