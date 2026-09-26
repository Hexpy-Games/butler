//! Public projection of source-managed Project Work. Private manifests and
//! operation payloads never leave this module.

mod child;
mod projection;
mod proof;
mod validate;

use std::path::Path;

use crate::locale::LocaleCollation;
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
    let plan = manifest
        .get("currentPlanRevisionId")
        .and_then(Value::as_str)
        .map(|id| child::read_plan(root, binding, &work.id, id, collation))
        .transpose()?;
    let checkpoint = manifest
        .get("latestCheckpointRevisionId")
        .and_then(Value::as_str)
        .map(|id| {
            child::read_child(
                root,
                binding,
                &work.id,
                id,
                "butler.btcc-project-work-checkpoint.v1",
                collation,
            )
        })
        .transpose()?;
    let disposition = manifest
        .get("latestDispositionRevisionId")
        .and_then(Value::as_str)
        .map(|id| {
            child::read_child(
                root,
                binding,
                &work.id,
                id,
                "butler.btcc-project-work-disposition.v1",
                collation,
            )
        })
        .transpose()?;
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
    let public_summary = disposition
        .as_ref()
        .and_then(|item| item.get("disposition"))
        .and_then(|item| item.get("summary"))
        .and_then(Value::as_str)
        .or_else(|| {
            checkpoint
                .as_ref()
                .and_then(|item| item.get("checkpoint"))
                .and_then(|item| item.get("publicSummary"))
                .and_then(Value::as_str)
        })
        .map(str::to_owned);
    let latest_checkpoint = checkpoint
        .as_ref()
        .map(projection::checkpoint_summary)
        .transpose()?;
    let latest_disposition = disposition
        .as_ref()
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
        objective: required_string(&manifest, "objective")?.into(),
        session_id: required_string(&manifest, "sessionId")?.into(),
        status: required_string(&manifest, "status")?.into(),
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
    let required = [
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
    let optional = [
        "currentStage",
        "currentPlanRevisionId",
        "latestCheckpointRevisionId",
        "latestPlanReviewRevisionId",
        "latestResultReviewRevisionId",
        "latestCompletionValidationRevisionId",
        "latestDispositionRevisionId",
    ];
    if required.iter().any(|key| !object.contains_key(*key))
        || object
            .keys()
            .any(|key| !required.contains(&key.as_str()) && !optional.contains(&key.as_str()))
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
    for name in [
        "allowedNextStages",
        "actionProgress",
        "resultRefs",
        "bindingRefs",
    ] {
        if value
            .get(name)
            .and_then(Value::as_array)
            .is_none_or(|items| items.len() > 512)
        {
            return Err(invalid());
        }
    }
    for name in [
        "planRevision",
        "checkpointRevision",
        "checkpointResultSequence",
        "reviewRevision",
        "dispositionRevision",
        "resultSequence",
    ] {
        if value.get(name).and_then(Value::as_u64).is_none() {
            return Err(invalid());
        }
    }
    if value.get("resultSequence").and_then(Value::as_u64)
        != value
            .get("resultRefs")
            .and_then(Value::as_array)
            .map(|items| items.len() as u64)
        || value
            .get("checkpointResultSequence")
            .and_then(Value::as_u64)
            > value.get("resultSequence").and_then(Value::as_u64)
    {
        return Err(invalid());
    }
    for (pointer, counter) in [
        ("currentPlanRevisionId", "planRevision"),
        ("latestCheckpointRevisionId", "checkpointRevision"),
        ("latestDispositionRevisionId", "dispositionRevision"),
    ] {
        if value.get(pointer).is_some()
            != (value
                .get(counter)
                .and_then(Value::as_u64)
                .unwrap_or_default()
                > 0)
        {
            return Err(invalid());
        }
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
            !crate::public_text::trim_js_whitespace(text).is_empty()
                && text.encode_utf16().count() <= 4096
        })
        .ok_or_else(invalid)
}

pub(super) fn invalid() -> ProjectLedgerReadError {
    ProjectLedgerReadError::RecordShow("project_work_managed_record_invalid")
}
