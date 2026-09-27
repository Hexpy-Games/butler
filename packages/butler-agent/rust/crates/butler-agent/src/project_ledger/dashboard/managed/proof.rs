mod material;
mod occurrence;
mod relations;

use std::collections::HashSet;
use std::path::Path;

use crate::locale::LocaleCollation;
use serde_json::Value;

use super::{ManagedPlanView, child, invalid, required_string};
use crate::project_ledger::ProjectLedgerReadError;
use crate::project_ledger::dashboard::{
    DashboardLedgerRecord, ProjectLedgerBinding, exact::ExactRecord,
};

pub(super) fn validate_official_work(
    _root: &Path,
    _binding: &ProjectLedgerBinding,
    record: &DashboardLedgerRecord,
    exact: &ExactRecord,
    manifest: &Value,
) -> Result<(), ProjectLedgerReadError> {
    let status = match required_string(manifest, "status")? {
        "blocked" => "blocked",
        "completed" => "review",
        "abandoned" => "cancelled",
        "open" => "in_progress",
        _ => return Err(invalid()),
    };
    let metadata = &exact.metadata;
    if metadata.get("schema").and_then(Value::as_str) != Some("project-ledger.work.v1")
        || metadata.get("spec").and_then(Value::as_str) != Some(super::PROJECT_WORK_SPEC)
        || metadata.get("id").and_then(Value::as_str) != Some(&record.id)
        || metadata.get("status").and_then(Value::as_str) != Some(status)
        || metadata
            .get("title")
            .and_then(Value::as_str)
            .is_none_or(str::is_empty)
        || [
            "acceptance",
            "acceptanceExemption",
            "validation",
            "review",
            "report",
            "codeCommits",
            "ledgerCommits",
            "requiresCommitEvidence",
        ]
        .iter()
        .any(|key| metadata.get(*key).is_some())
    {
        return Err(invalid());
    }
    Ok(())
}

pub(super) fn validate_history_child(
    root: &Path,
    binding: &ProjectLedgerBinding,
    work_id: &str,
    id: &str,
    kind: &str,
    child: &Value,
    collation: &LocaleCollation,
) -> Result<(), ProjectLedgerReadError> {
    if child.get("workId").and_then(Value::as_str) != Some(work_id) {
        return Err(invalid());
    }
    occurrence::validate(root, binding, id, kind, child, collation)
}

#[derive(Clone, Copy)]
pub(super) struct CurrentChildrenInput<'a> {
    pub root: &'a Path,
    pub binding: &'a ProjectLedgerBinding,
    pub work: &'a DashboardLedgerRecord,
    pub manifest: &'a Value,
    pub plan: Option<&'a ManagedPlanView>,
    pub checkpoint: Option<&'a Value>,
    pub disposition: Option<&'a Value>,
    pub collation: &'a LocaleCollation,
}

pub(super) struct CurrentReviewCorrections {
    pub latest_plan: Vec<String>,
    pub latest_result: Vec<String>,
}

pub(super) fn validate_current_children(
    input: CurrentChildrenInput<'_>,
) -> Result<CurrentReviewCorrections, ProjectLedgerReadError> {
    let CurrentChildrenInput {
        root,
        binding,
        work,
        manifest,
        plan,
        checkpoint,
        disposition,
        collation,
    } = input;
    let plan_revision = manifest
        .get("planRevision")
        .and_then(Value::as_u64)
        .ok_or_else(invalid)?;
    if plan.map(|item| item.objective.as_str())
        != manifest
            .get("currentPlanRevisionId")
            .and_then(Value::as_str)
            .map(|_| required_string(manifest, "objective"))
            .transpose()?
        || plan_revision == 0 && plan.is_some()
    {
        return Err(invalid());
    }
    let mut plan_child = None;
    if let Some(plan) = plan {
        let child = child::read_child(
            root,
            binding,
            &work.id,
            &plan.id,
            "butler.btcc-project-work-plan.v1",
            collation,
        )?;
        if child.pointer("/plan/revision").and_then(Value::as_u64) != Some(plan_revision)
            || child.pointer("/plan/objective").and_then(Value::as_str) != Some(&plan.objective)
        {
            return Err(invalid());
        }
        occurrence::validate(root, binding, &work.id, "work", manifest, collation)?;
        occurrence::validate(root, binding, &plan.id, "plan", &child, collation)?;
        plan_child = Some(child);
    } else {
        occurrence::validate(root, binding, &work.id, "work", manifest, collation)?;
    }
    if let Some(child) = checkpoint {
        let checkpoint = child.get("checkpoint").ok_or_else(invalid)?;
        if checkpoint.get("revision") != manifest.get("checkpointRevision")
            || checkpoint.get("planRevisionId") != manifest.get("currentPlanRevisionId")
            || checkpoint.get("stage") != manifest.get("currentStage")
            || checkpoint.get("actionProgress") != manifest.get("actionProgress")
            || child
                .pointer("/resultWindow/fromSequence")
                .and_then(Value::as_u64)
                != Some(0)
            || child.pointer("/resultWindow/toSequence") != manifest.get("checkpointResultSequence")
        {
            return Err(invalid());
        }
        occurrence::validate(
            root,
            binding,
            required_string(checkpoint, "checkpointRevisionId")?,
            "reference",
            child,
            collation,
        )?;
    }
    let mut review_children: [Option<Value>; 3] = [None, None, None];
    for (index, (pointer, subject)) in [
        ("latestPlanReviewRevisionId", "plan"),
        ("latestResultReviewRevisionId", "result"),
        ("latestCompletionValidationRevisionId", "completion"),
    ]
    .into_iter()
    .enumerate()
    {
        if let Some(id) = manifest.get(pointer).and_then(Value::as_str) {
            let child = child::read_child(
                root,
                binding,
                &work.id,
                id,
                "butler.btcc-project-work-review.v1",
                collation,
            )?;
            if child.pointer("/review/subject").and_then(Value::as_str) != Some(subject)
                || child.pointer("/review/revision").and_then(Value::as_u64)
                    > manifest.get("reviewRevision").and_then(Value::as_u64)
            {
                return Err(invalid());
            }
            occurrence::validate(root, binding, id, "reference", &child, collation)?;
            review_children[index] = Some(child);
        }
    }
    if let Some(completion) = review_children[2].as_ref() {
        let review = completion.get("review").ok_or_else(invalid)?;
        let bound_id = required_string(review, "boundResultReviewRevisionId")?;
        let bound = child::read_child(
            root,
            binding,
            &work.id,
            bound_id,
            "butler.btcc-project-work-review.v1",
            collation,
        )?;
        let bound_review = bound.get("review").ok_or_else(invalid)?;
        let matching_actions = bound_review
            .get("boundActionProgress")
            .and_then(Value::as_array)
            .zip(review.get("boundActionProgress").and_then(Value::as_array))
            .is_some_and(|(left, right)| {
                left.len() == right.len()
                    && left
                        .iter()
                        .zip(right)
                        .all(|(left, right)| left.get("actionKey") == right.get("actionKey"))
            });
        if bound_review.get("subject").and_then(Value::as_str) != Some("result")
            || bound_review.get("verdict").and_then(Value::as_str) != Some("accept")
            || bound_review.get("revision").and_then(Value::as_u64)
                >= review.get("revision").and_then(Value::as_u64)
            || bound.get("boundResultSequence") != completion.get("boundResultSequence")
            || bound_review.get("boundResultRefs") != review.get("boundResultRefs")
            || !matching_actions
        {
            return Err(invalid());
        }
        occurrence::validate(root, binding, bound_id, "reference", &bound, collation)?;
    }
    if let Some(child) = disposition {
        let disposition = child.get("disposition").ok_or_else(invalid)?;
        if disposition.get("revision") != manifest.get("dispositionRevision")
            || disposition.get("materialFingerprint") != manifest.get("materialFingerprint")
            || disposition.get("resultSequence") != manifest.get("resultSequence")
        {
            return Err(invalid());
        }
        occurrence::validate(
            root,
            binding,
            required_string(disposition, "dispositionRevisionId")?,
            "reference",
            child,
            collation,
        )?;
    }
    let mut result_ids = HashSet::new();
    let results = manifest
        .get("resultRefs")
        .and_then(Value::as_array)
        .ok_or_else(invalid)?;
    for (index, result) in results.iter().enumerate() {
        let id = required_string(result, "resultRef")?;
        if !result_ids.insert(id) {
            return Err(invalid());
        }
        let child = child::read_child(
            root,
            binding,
            &work.id,
            id,
            "butler.btcc-project-work-result-reference.v1",
            collation,
        )?;
        if child.pointer("/result/sequence").and_then(Value::as_u64) != Some(index as u64 + 1)
            || child.pointer("/sessionId") != manifest.get("sessionId")
            || child.pointer("/scope") != manifest.get("scope")
            || child.pointer("/result/toolCallId") != result.get("toolCallId")
            || child.pointer("/result/toolName") != result.get("toolName")
            || child.pointer("/result/status") != result.get("status")
        {
            return Err(invalid());
        }
        occurrence::validate(root, binding, id, "reference", &child, collation)?;
    }
    let bindings = manifest
        .get("bindingRefs")
        .and_then(Value::as_array)
        .ok_or_else(invalid)?;
    for binding_ref in bindings {
        let id = required_string(binding_ref, "bindingRevisionId")?;
        let child = child::read_child(
            root,
            binding,
            &work.id,
            id,
            "butler.btcc-project-work-binding.v1",
            collation,
        )?;
        if child.pointer("/binding/turnId") != binding_ref.get("turnId")
            || child.pointer("/binding/revision") != binding_ref.get("revision")
            || child.pointer("/binding/sessionId") != manifest.get("sessionId")
            || child
                .pointer("/binding/bindingRevisionId")
                .and_then(Value::as_str)
                != Some(
                    relations::binding_id(
                        required_string(binding_ref, "turnId")?,
                        binding_ref
                            .get("revision")
                            .and_then(Value::as_u64)
                            .ok_or_else(invalid)?,
                        &work.id,
                    )
                    .as_str(),
                )
        {
            return Err(invalid());
        }
        occurrence::validate(root, binding, id, "reference", &child, collation)?;
    }
    relations::validate(
        manifest,
        plan_child.as_ref(),
        checkpoint,
        &review_children,
        disposition,
    )?;
    material::matches(manifest, plan_child.as_ref(), checkpoint, &review_children)?;
    Ok(CurrentReviewCorrections {
        latest_plan: review_corrections(review_children[0].as_ref())?,
        latest_result: review_corrections(review_children[1].as_ref())?,
    })
}

fn review_corrections(child_value: Option<&Value>) -> Result<Vec<String>, ProjectLedgerReadError> {
    match child_value {
        Some(value) => child::strings(value.pointer("/review/corrections").ok_or_else(invalid)?),
        None => Ok(Vec::new()),
    }
}
