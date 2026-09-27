mod material;
mod occurrence;
mod relations;

use std::collections::HashSet;
use std::path::Path;

use butler_core::locale::LocaleCollation;
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

/// Checks every child record the manifest points at — plan, checkpoint,
/// reviews, disposition, results and bindings — against the manifest and its
/// occurrence, then the relations and material between them.
pub(super) fn validate_current_children(
    input: CurrentChildrenInput<'_>,
) -> Result<CurrentReviewCorrections, ProjectLedgerReadError> {
    let plan_child = current_plan(&input)?;
    if let Some(child) = input.checkpoint {
        current_checkpoint(&input, child)?;
    }
    let review_children = current_reviews(&input)?;
    if let [_, _, Some(completion)] = &review_children {
        completion_bound_review(&input, completion)?;
    }
    if let Some(child) = input.disposition {
        current_disposition(&input, child)?;
    }
    result_references(&input)?;
    binding_references(&input)?;
    let [plan_review, result_review, _] = &review_children;
    relations::validate(
        input.manifest,
        plan_child.as_ref(),
        input.checkpoint,
        &review_children,
        input.disposition,
    )?;
    material::matches(
        input.manifest,
        plan_child.as_ref(),
        input.checkpoint,
        &review_children,
    )?;
    Ok(CurrentReviewCorrections {
        latest_plan: review_corrections(plan_review.as_ref())?,
        latest_result: review_corrections(result_review.as_ref())?,
    })
}

impl CurrentChildrenInput<'_> {
    fn read_child(&self, id: &str, schema: &str) -> Result<Value, ProjectLedgerReadError> {
        child::read_child(
            self.root,
            self.binding,
            &self.work.id,
            id,
            schema,
            self.collation,
        )
    }

    fn occurrence(
        &self,
        id: &str,
        kind: &str,
        child: &Value,
    ) -> Result<(), ProjectLedgerReadError> {
        occurrence::validate(self.root, self.binding, id, kind, child, self.collation)
    }
}

/// The current plan child agrees with the manifest's plan revision and
/// objective; the Work and plan occurrences are validated.
fn current_plan(input: &CurrentChildrenInput<'_>) -> Result<Option<Value>, ProjectLedgerReadError> {
    let manifest = input.manifest;
    let plan_revision = manifest
        .get("planRevision")
        .and_then(Value::as_u64)
        .ok_or_else(invalid)?;
    if input.plan.map(|item| item.objective.as_str())
        != manifest
            .get("currentPlanRevisionId")
            .and_then(Value::as_str)
            .map(|_| required_string(manifest, "objective"))
            .transpose()?
        || plan_revision == 0 && input.plan.is_some()
    {
        return Err(invalid());
    }
    let Some(plan) = input.plan else {
        input.occurrence(&input.work.id, "work", manifest)?;
        return Ok(None);
    };
    let child = input.read_child(&plan.id, "butler.btcc-project-work-plan.v1")?;
    if child.pointer("/plan/revision").and_then(Value::as_u64) != Some(plan_revision)
        || child.pointer("/plan/objective").and_then(Value::as_str) != Some(&plan.objective)
    {
        return Err(invalid());
    }
    input.occurrence(&input.work.id, "work", manifest)?;
    input.occurrence(&plan.id, "plan", &child)?;
    Ok(Some(child))
}

fn current_checkpoint(
    input: &CurrentChildrenInput<'_>,
    child: &Value,
) -> Result<(), ProjectLedgerReadError> {
    let manifest = input.manifest;
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
    input.occurrence(
        required_string(checkpoint, "checkpointRevisionId")?,
        "reference",
        child,
    )
}

/// The latest plan, result and completion reviews, in that order.
fn current_reviews(
    input: &CurrentChildrenInput<'_>,
) -> Result<[Option<Value>; 3], ProjectLedgerReadError> {
    let manifest = input.manifest;
    let mut review_children: [Option<Value>; 3] = [None, None, None];
    let pointers = [
        ("latestPlanReviewRevisionId", "plan"),
        ("latestResultReviewRevisionId", "result"),
        ("latestCompletionValidationRevisionId", "completion"),
    ];
    for (slot, (pointer, subject)) in review_children.iter_mut().zip(pointers) {
        let Some(id) = manifest.get(pointer).and_then(Value::as_str) else {
            continue;
        };
        let child = input.read_child(id, "butler.btcc-project-work-review.v1")?;
        if child.pointer("/review/subject").and_then(Value::as_str) != Some(subject)
            || child.pointer("/review/revision").and_then(Value::as_u64)
                > manifest.get("reviewRevision").and_then(Value::as_u64)
        {
            return Err(invalid());
        }
        input.occurrence(id, "reference", &child)?;
        *slot = Some(child);
    }
    Ok(review_children)
}

/// A completion validation is bound to an earlier accepted result review
/// over the same results and actions.
fn completion_bound_review(
    input: &CurrentChildrenInput<'_>,
    completion: &Value,
) -> Result<(), ProjectLedgerReadError> {
    let review = completion.get("review").ok_or_else(invalid)?;
    let bound_id = required_string(review, "boundResultReviewRevisionId")?;
    let bound = input.read_child(bound_id, "butler.btcc-project-work-review.v1")?;
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
    input.occurrence(bound_id, "reference", &bound)
}

fn current_disposition(
    input: &CurrentChildrenInput<'_>,
    child: &Value,
) -> Result<(), ProjectLedgerReadError> {
    let manifest = input.manifest;
    let disposition = child.get("disposition").ok_or_else(invalid)?;
    if disposition.get("revision") != manifest.get("dispositionRevision")
        || disposition.get("materialFingerprint") != manifest.get("materialFingerprint")
        || disposition.get("resultSequence") != manifest.get("resultSequence")
    {
        return Err(invalid());
    }
    input.occurrence(
        required_string(disposition, "dispositionRevisionId")?,
        "reference",
        child,
    )
}

/// Every result reference is unique, in sequence and matches its child.
fn result_references(input: &CurrentChildrenInput<'_>) -> Result<(), ProjectLedgerReadError> {
    let manifest = input.manifest;
    let mut result_ids = HashSet::new();
    let results = manifest
        .get("resultRefs")
        .and_then(Value::as_array)
        .ok_or_else(invalid)?;
    for (sequence, result) in (1_u64..).zip(results) {
        let id = required_string(result, "resultRef")?;
        if !result_ids.insert(id) {
            return Err(invalid());
        }
        let child = input.read_child(id, "butler.btcc-project-work-result-reference.v1")?;
        if child.pointer("/result/sequence").and_then(Value::as_u64) != Some(sequence)
            || child.pointer("/sessionId") != manifest.get("sessionId")
            || child.pointer("/scope") != manifest.get("scope")
            || child.pointer("/result/toolCallId") != result.get("toolCallId")
            || child.pointer("/result/toolName") != result.get("toolName")
            || child.pointer("/result/status") != result.get("status")
        {
            return Err(invalid());
        }
        input.occurrence(id, "reference", &child)?;
    }
    Ok(())
}

/// Every binding reference matches its child and its derived id.
fn binding_references(input: &CurrentChildrenInput<'_>) -> Result<(), ProjectLedgerReadError> {
    let manifest = input.manifest;
    let bindings = manifest
        .get("bindingRefs")
        .and_then(Value::as_array)
        .ok_or_else(invalid)?;
    for binding_ref in bindings {
        let id = required_string(binding_ref, "bindingRevisionId")?;
        let child = input.read_child(id, "butler.btcc-project-work-binding.v1")?;
        let expected_id = relations::binding_id(
            required_string(binding_ref, "turnId")?,
            binding_ref
                .get("revision")
                .and_then(Value::as_u64)
                .ok_or_else(invalid)?,
            &input.work.id,
        );
        if child.pointer("/binding/turnId") != binding_ref.get("turnId")
            || child.pointer("/binding/revision") != binding_ref.get("revision")
            || child.pointer("/binding/sessionId") != manifest.get("sessionId")
            || child
                .pointer("/binding/bindingRevisionId")
                .and_then(Value::as_str)
                != Some(expected_id.as_str())
        {
            return Err(invalid());
        }
        input.occurrence(id, "reference", &child)?;
    }
    Ok(())
}

fn review_corrections(child_value: Option<&Value>) -> Result<Vec<String>, ProjectLedgerReadError> {
    match child_value {
        Some(value) => child::strings(value.pointer("/review/corrections").ok_or_else(invalid)?),
        None => Ok(Vec::new()),
    }
}
