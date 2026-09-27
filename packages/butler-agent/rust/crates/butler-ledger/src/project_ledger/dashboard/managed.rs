//! Public projection of source-managed Project Work. Private manifests and
//! operation payloads never leave this module.

mod child;
mod projection;
mod proof;
mod validate;

use std::path::Path;

use butler_core::locale::LocaleCollation;
use serde_json::Value;

use super::{
    DashboardActionProgress, DashboardLedgerRecord, DashboardManagedPlanView,
    DashboardManagedWorkView, ProjectLedgerBinding, exact::ExactRecord,
};
use crate::project_ledger::ProjectLedgerReadError;

pub(super) const PROJECT_WORK_SPEC: &str = "SPEC-BTCC-R3-WORK-LEDGER-SCOPE";
pub(super) type ManagedPlanView = DashboardManagedPlanView;

impl DashboardManagedPlanView {
    pub(super) fn public_markdown(&self) -> String {
        let mut lines = vec![format!("# {}", self.objective)];
        lines.extend(self.actions.iter().map(|item| format!("- {item}")));
        lines.extend(self.checks.iter().map(|item| format!("- {item}")));
        lines.join("\n\n")
    }
}

impl DashboardManagedWorkView {
    pub(super) fn public_markdown(&self) -> String {
        let mut lines = vec![format!("# {}", self.objective)];
        if let Some(summary) = &self.public_summary
            && !summary.is_empty()
        {
            lines.push(summary.clone());
        }
        lines.extend(
            self.remaining_actions
                .iter()
                .map(|item| format!("- [ ] {item}")),
        );
        lines.extend(self.followups.iter().map(|item| format!("- {item}")));
        lines.join("\n\n")
    }
}

/// The public view of one managed Work: its manifest and current children
/// are decoded and proven, then projected without private payloads.
pub(super) fn read_current(
    root: &Path,
    binding: &ProjectLedgerBinding,
    work: &DashboardLedgerRecord,
    exact: &ExactRecord,
    collation: &LocaleCollation,
) -> Result<DashboardManagedWorkView, ProjectLedgerReadError> {
    let manifest = decode_manifest_body(
        &exact.body,
        &work.id,
        &binding.app_project_id,
        &binding.ledger_project_id,
        collation,
    )?;
    proof::validate_official_work(root, binding, work, exact, &manifest)?;
    let pointed = |pointer: &str, schema: &str| {
        manifest
            .get(pointer)
            .and_then(Value::as_str)
            .map(|id| child::read_child(root, binding, &work.id, id, schema, collation))
            .transpose()
    };
    let plan = manifest
        .get("currentPlanRevisionId")
        .and_then(Value::as_str)
        .map(|id| child::read_plan(root, binding, &work.id, id, collation))
        .transpose()?;
    let checkpoint = pointed(
        "latestCheckpointRevisionId",
        "butler.btcc-project-work-checkpoint.v1",
    )?;
    let disposition = pointed(
        "latestDispositionRevisionId",
        "butler.btcc-project-work-disposition.v1",
    )?;
    let reviews = proof::validate_current_children(proof::CurrentChildrenInput {
        root,
        binding,
        work,
        manifest: &manifest,
        plan: plan.as_ref(),
        checkpoint: checkpoint.as_ref(),
        disposition: disposition.as_ref(),
        collation,
    })?;
    project(
        &manifest,
        plan,
        checkpoint.as_ref(),
        disposition.as_ref(),
        reviews,
    )
}

/// The dashboard projection of a proven manifest and its children.
fn project(
    manifest: &Value,
    plan: Option<ManagedPlanView>,
    checkpoint: Option<&Value>,
    disposition: Option<&Value>,
    reviews: proof::CurrentReviewCorrections,
) -> Result<DashboardManagedWorkView, ProjectLedgerReadError> {
    let public_summary = disposition
        .and_then(|item| item.get("disposition"))
        .and_then(|item| item.get("summary"))
        .and_then(Value::as_str)
        .or_else(|| {
            checkpoint
                .and_then(|item| item.get("checkpoint"))
                .and_then(|item| item.get("publicSummary"))
                .and_then(Value::as_str)
        })
        .map(str::to_owned);
    let latest_checkpoint = checkpoint.map(projection::checkpoint_summary).transpose()?;
    let latest_disposition = disposition
        .map(projection::disposition_summary)
        .transpose()?;
    let remaining_actions = latest_disposition
        .as_ref()
        .map_or_else(Vec::new, |value| value.remaining_actions.clone());
    let followups = latest_disposition
        .as_ref()
        .map_or_else(Vec::new, |value| value.followups.clone());
    let action_progress = manifest
        .get("actionProgress")
        .and_then(Value::as_array)
        .ok_or_else(invalid)?
        .iter()
        .map(|item| {
            required_string(item, "actionKey")?;
            Ok(DashboardActionProgress {
                status: required_string(item, "status")?.to_owned(),
            })
        })
        .collect::<Result<Vec<_>, ProjectLedgerReadError>>()?;
    Ok(DashboardManagedWorkView {
        objective: required_string(manifest, "objective")?.into(),
        session_id: required_string(manifest, "sessionId")?.into(),
        status: required_string(manifest, "status")?.into(),
        current_stage: manifest
            .get("currentStage")
            .and_then(Value::as_str)
            .map(str::to_owned),
        action_progress,
        current_plan: plan,
        latest_checkpoint,
        latest_disposition,
        latest_plan_review_corrections: reviews.latest_plan,
        latest_result_review_corrections: reviews.latest_result,
        public_summary,
        remaining_actions,
        followups,
    })
}

pub(super) fn read_history_child(
    root: &Path,
    binding: &ProjectLedgerBinding,
    work_id: &str,
    id: &str,
    schema: &str,
    collation: &LocaleCollation,
) -> Result<Value, ProjectLedgerReadError> {
    let child = child::read_child(root, binding, work_id, id, schema, collation)?;
    proof::validate_history_child(root, binding, work_id, id, "reference", &child, collation)?;
    Ok(child)
}

pub(super) fn read_plan_child(
    root: &Path,
    binding: &ProjectLedgerBinding,
    work_id: &str,
    id: &str,
    collation: &LocaleCollation,
) -> Result<ManagedPlanView, ProjectLedgerReadError> {
    let plan = child::read_plan(root, binding, work_id, id, collation)?;
    let value = child::read_child(
        root,
        binding,
        work_id,
        id,
        "butler.btcc-project-work-plan.v1",
        collation,
    )?;
    proof::validate_history_child(root, binding, work_id, id, "plan", &value, collation)?;
    Ok(plan)
}

pub(in crate::project_ledger) fn decode_manifest_body(
    body: &str,
    work_id: &str,
    app_project_id: &str,
    ledger_project_id: &str,
    collation: &LocaleCollation,
) -> Result<Value, ProjectLedgerReadError> {
    let manifest = child::parse_canonical(body, collation)?;
    validate_manifest(&manifest, work_id, app_project_id, ledger_project_id)?;
    validate::manifest(&manifest)?;
    Ok(manifest)
}

pub(in crate::project_ledger) fn decode_child_body(
    body: &str,
    work_id: &str,
    id: &str,
    schema: &str,
    collation: &LocaleCollation,
) -> Result<Value, ProjectLedgerReadError> {
    child::decode_body(body, work_id, id, schema, collation)
}

const MANIFEST_REQUIRED: [&str; 23] = [
    "schema",
    "workId",
    "sessionId",
    "scope",
    "origin",
    "objective",
    "status",
    "sessionHead",
    "allowedNextStages",
    "actionProgress",
    "resultRefs",
    "bindingRefs",
    "planRevision",
    "checkpointRevision",
    "checkpointResultSequence",
    "reviewRevision",
    "dispositionRevision",
    "resultSequence",
    "materialFingerprint",
    "materialSnapshot",
    "operationIdentity",
    "createdAt",
    "updatedAt",
];

const MANIFEST_OPTIONAL: [&str; 7] = [
    "currentStage",
    "currentPlanRevisionId",
    "latestCheckpointRevisionId",
    "latestPlanReviewRevisionId",
    "latestResultReviewRevisionId",
    "latestCompletionValidationRevisionId",
    "latestDispositionRevisionId",
];

/// The manifest's shape, identity and counters: this Work in this binding,
/// exactly the known keys, bounded lists, and pointers present exactly when
/// their revision counter is positive.
fn validate_manifest(
    value: &Value,
    work_id: &str,
    app_project_id: &str,
    ledger_project_id: &str,
) -> Result<(), ProjectLedgerReadError> {
    let object = value.as_object().ok_or_else(invalid)?;
    let scope = value
        .get("scope")
        .and_then(Value::as_object)
        .ok_or_else(invalid)?;
    if scope.len() != 2
        || !scope.contains_key("appProjectId")
        || !scope.contains_key("ledgerProjectId")
    {
        return Err(invalid());
    }
    if MANIFEST_REQUIRED
        .iter()
        .any(|key| !object.contains_key(*key))
        || object.keys().any(|key| {
            !MANIFEST_REQUIRED.contains(&key.as_str()) && !MANIFEST_OPTIONAL.contains(&key.as_str())
        })
        || required_string(value, "schema")? != "butler.btcc-project-work.v1"
        || required_string(value, "workId")? != work_id
        || value.pointer("/scope/appProjectId").and_then(Value::as_str) != Some(app_project_id)
        || value
            .pointer("/scope/ledgerProjectId")
            .and_then(Value::as_str)
            != Some(ledger_project_id)
        || !matches!(
            required_string(value, "status")?,
            "open" | "blocked" | "completed" | "abandoned"
        )
        || value.get("sessionHead").and_then(Value::as_bool).is_none()
    {
        return Err(invalid());
    }
    required_string(value, "sessionId")?;
    required_string(value, "objective")?;
    required_string(value, "materialFingerprint")?;
    manifest_counters(value)
}

fn manifest_counters(value: &Value) -> Result<(), ProjectLedgerReadError> {
    let lists = [
        "allowedNextStages",
        "actionProgress",
        "resultRefs",
        "bindingRefs",
    ];
    if lists.iter().any(|name| {
        value
            .get(*name)
            .and_then(Value::as_array)
            .is_none_or(|items| items.len() > 512)
    }) {
        return Err(invalid());
    }
    let counter = |name: &str| value.get(name).and_then(Value::as_u64);
    let counters = [
        "planRevision",
        "checkpointRevision",
        "checkpointResultSequence",
        "reviewRevision",
        "dispositionRevision",
        "resultSequence",
    ];
    if counters.iter().any(|name| counter(name).is_none()) {
        return Err(invalid());
    }
    if counter("resultSequence")
        != value
            .get("resultRefs")
            .and_then(Value::as_array)
            .map(|items| items.len() as u64)
        || counter("checkpointResultSequence") > counter("resultSequence")
    {
        return Err(invalid());
    }
    let pointers = [
        ("currentPlanRevisionId", "planRevision"),
        ("latestCheckpointRevisionId", "checkpointRevision"),
        ("latestDispositionRevisionId", "dispositionRevision"),
    ];
    if pointers.iter().any(|(pointer, name)| {
        value.get(*pointer).is_some() != (counter(name).unwrap_or_default() > 0)
    }) {
        return Err(invalid());
    }
    Ok(())
}

pub(super) fn required_string<'a>(
    value: &'a Value,
    key: &str,
) -> Result<&'a str, ProjectLedgerReadError> {
    value
        .get(key)
        .and_then(Value::as_str)
        .filter(|text| {
            !butler_core::public_text::trim_js_whitespace(text).is_empty()
                && text.encode_utf16().count() <= 4096
        })
        .ok_or_else(invalid)
}

pub(super) fn invalid() -> ProjectLedgerReadError {
    ProjectLedgerReadError::record_show("project_work_managed_record_invalid")
}
