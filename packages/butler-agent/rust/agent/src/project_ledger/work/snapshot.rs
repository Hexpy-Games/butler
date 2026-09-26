use std::collections::{HashMap, HashSet};
use std::path::Path;

use serde_json::{Map, Value};
use sha2::{Digest, Sha256};

mod candidate;
mod dependencies;
mod validation;

pub(in crate::project_ledger) use candidate::validate_publication_candidate;

use crate::btcc::{BtccError, ResolvedProjectWorkScope, WorkView};
use crate::locale::LocaleCollation;

use super::super::{ProjectLedgerReadError, committed, dashboard, records};
use super::codec::{self, Snapshot};
use super::invalid;

impl super::ProjectWorkRepository {
    pub(super) async fn read_current(&self, work_id: &str) -> Result<Option<Snapshot>, BtccError> {
        let scope = self.scope.clone();
        let id = work_id.to_owned();
        self.shared
            .ledger
            .run(move |_, collation| read_current(&scope, &id, collation))
            .await
            .map_err(read_error)
    }

    pub(super) async fn require_current(&self, work_id: &str) -> Result<Snapshot, BtccError> {
        self.read_current(work_id)
            .await?
            .ok_or_else(|| invalid("project_work_record_missing"))
    }
}

pub(in crate::project_ledger) fn read_error(error: ProjectLedgerReadError) -> BtccError {
    match error {
        ProjectLedgerReadError::RecordShow(code)
        | ProjectLedgerReadError::Resolution(code)
        | ProjectLedgerReadError::Owner(code)
        | ProjectLedgerReadError::DashboardInternal(code)
        | ProjectLedgerReadError::DashboardUnavailable(code) => invalid(code),
        ProjectLedgerReadError::DashboardChanged => invalid("project_work_snapshot_unstable"),
    }
}

pub(in crate::project_ledger) fn read_current(
    scope: &ResolvedProjectWorkScope,
    work_id: &str,
    collation: &LocaleCollation,
) -> Result<Option<Snapshot>, ProjectLedgerReadError> {
    for _attempt in 0..3 {
        match current_attempt(scope, work_id, collation)? {
            Attempt::Missing => return Ok(None),
            Attempt::Changed => continue,
            Attempt::Ready(snapshot) => return Ok(Some(*snapshot)),
        }
    }
    Err(ProjectLedgerReadError::RecordShow(
        "project_work_snapshot_unstable",
    ))
}

enum Attempt {
    Missing,
    Changed,
    Ready(Box<Snapshot>),
}

fn current_attempt(
    scope: &ResolvedProjectWorkScope,
    work_id: &str,
    collation: &LocaleCollation,
) -> Result<Attempt, ProjectLedgerReadError> {
    let path = format!("work/{work_id}/work.md");
    let Some(raw) = committed::read_selected(&scope.ledger_root, &path)? else {
        return Ok(Attempt::Missing);
    };
    let mut observed = vec![(path, Sha256::digest(raw.as_bytes()).into())];
    let metadata = required_metadata(&raw, work_id, "work", None)?;
    if metadata.get("spec").and_then(Value::as_str) != Some(codec::SPEC) {
        return Err(managed_invalid());
    }
    let body = records::frontmatter_body_ref(&raw);
    let manifest = dashboard::decode_manifest_body(
        body,
        work_id,
        &scope.app_project_id,
        &scope.ledger_project_id,
        collation,
    )?;
    let direct = child_refs(&manifest)?;
    let mut children = HashMap::with_capacity(direct.len());
    for (id, kind, schema) in direct {
        read_child(ChildReadInput {
            scope,
            work_id,
            collation,
            id: &id,
            kind,
            schema,
            children: &mut children,
            observed: &mut observed,
        })?;
    }
    let dependencies = dependencies::refs(&manifest, &children).map_err(|_| managed_invalid())?;
    for (id, kind, schema) in dependencies {
        if let Some(existing) = children.get(&id) {
            if existing.get("schema").and_then(Value::as_str) != Some(schema) {
                return Err(managed_invalid());
            }
            continue;
        }
        read_child(ChildReadInput {
            scope,
            work_id,
            collation,
            id: &id,
            kind,
            schema,
            children: &mut children,
            observed: &mut observed,
        })?;
    }
    // The source reads initial, stable and dependency-complete snapshots, then
    // revalidates the entire exact read set. Keep only digests while doing so.
    if !unchanged(&scope.ledger_root, &observed)? {
        return Ok(Attempt::Changed);
    }
    let view = hydrate(&manifest, &children).map_err(|_| managed_invalid())?;
    dashboard::validate_managed_work(&scope.ledger_root, scope, work_id, collation)?;
    if !unchanged(&scope.ledger_root, &observed)? {
        return Ok(Attempt::Changed);
    }
    let status = match view.status {
        crate::btcc::DurableWorkStatus::Open => "in_progress",
        crate::btcc::DurableWorkStatus::Blocked => "blocked",
        crate::btcc::DurableWorkStatus::Completed => "review",
        crate::btcc::DurableWorkStatus::Abandoned => "cancelled",
    };
    if metadata.get("status").and_then(Value::as_str) != Some(status) {
        return Err(managed_invalid());
    }
    Ok(Attempt::Ready(Box::new(Snapshot {
        manifest,
        view,
        children,
    })))
}

struct ChildReadInput<'a> {
    scope: &'a ResolvedProjectWorkScope,
    work_id: &'a str,
    collation: &'a LocaleCollation,
    id: &'a str,
    kind: &'a str,
    schema: &'a str,
    children: &'a mut HashMap<String, Value>,
    observed: &'a mut Vec<(String, [u8; 32])>,
}

fn read_child(input: ChildReadInput<'_>) -> Result<(), ProjectLedgerReadError> {
    let ChildReadInput {
        scope,
        work_id,
        collation,
        id,
        kind,
        schema,
        children,
        observed,
    } = input;
    let path = if kind == "plan" {
        format!("plans/{}.md", id.to_lowercase())
    } else {
        format!("references/{}.md", id.to_lowercase())
    };
    let raw = committed::read_selected(&scope.ledger_root, &path)?.ok_or_else(managed_invalid)?;
    required_metadata(&raw, id, kind, Some(work_id))?;
    let body = records::frontmatter_body_ref(&raw);
    let child = dashboard::decode_child_body(body, work_id, id, schema, collation)?;
    observed.push((path, Sha256::digest(raw.as_bytes()).into()));
    children.insert(id.to_owned(), child);
    Ok(())
}

fn unchanged(root: &Path, observed: &[(String, [u8; 32])]) -> Result<bool, ProjectLedgerReadError> {
    for (path, expected) in observed {
        let now = committed::read_selected(root, path)?;
        if now
            .as_ref()
            .map(|raw| Sha256::digest(raw.as_bytes()).into())
            != Some(*expected)
        {
            return Ok(false);
        }
    }
    Ok(true)
}

fn required_metadata(
    raw: &str,
    id: &str,
    kind: &str,
    parent: Option<&str>,
) -> Result<Value, ProjectLedgerReadError> {
    let metadata = records::frontmatter(raw).ok_or_else(managed_invalid)?;
    if metadata.get("id").and_then(Value::as_str) != Some(id)
        || metadata.get("kind").and_then(Value::as_str) != Some(kind)
        || metadata.get("parentId").and_then(Value::as_str) != parent
    {
        return Err(managed_invalid());
    }
    Ok(metadata)
}

pub(super) fn child_refs(
    manifest: &Value,
) -> Result<Vec<(String, &'static str, &'static str)>, ProjectLedgerReadError> {
    let mut refs = Vec::new();
    let mut seen = HashSet::new();
    let mut add = |id: &str, kind, schema| {
        if !seen.insert(id.to_owned()) {
            return Err(managed_invalid());
        }
        refs.push((id.to_owned(), kind, schema));
        Ok(())
    };
    for (key, kind, schema) in [
        (
            "currentPlanRevisionId",
            "plan",
            "butler.btcc-project-work-plan.v1",
        ),
        (
            "latestCheckpointRevisionId",
            "reference",
            "butler.btcc-project-work-checkpoint.v1",
        ),
        (
            "latestPlanReviewRevisionId",
            "reference",
            "butler.btcc-project-work-review.v1",
        ),
        (
            "latestResultReviewRevisionId",
            "reference",
            "butler.btcc-project-work-review.v1",
        ),
        (
            "latestCompletionValidationRevisionId",
            "reference",
            "butler.btcc-project-work-review.v1",
        ),
        (
            "latestDispositionRevisionId",
            "reference",
            "butler.btcc-project-work-disposition.v1",
        ),
    ] {
        if let Some(id) = manifest.get(key).and_then(Value::as_str) {
            add(id, kind, schema)?;
        }
    }
    for binding in manifest
        .get("bindingRefs")
        .and_then(Value::as_array)
        .ok_or_else(managed_invalid)?
    {
        add(
            binding
                .get("bindingRevisionId")
                .and_then(Value::as_str)
                .ok_or_else(managed_invalid)?,
            "reference",
            "butler.btcc-project-work-binding.v1",
        )?;
    }
    for result in manifest
        .get("resultRefs")
        .and_then(Value::as_array)
        .ok_or_else(managed_invalid)?
    {
        add(
            result
                .get("resultRef")
                .and_then(Value::as_str)
                .ok_or_else(managed_invalid)?,
            "reference",
            "butler.btcc-project-work-result-reference.v1",
        )?;
    }
    Ok(refs)
}

pub(super) fn hydrate(
    manifest: &Value,
    children: &HashMap<String, Value>,
) -> Result<WorkView, BtccError> {
    let mut value = Map::new();
    for key in [
        "workId",
        "sessionId",
        "origin",
        "objective",
        "status",
        "currentStage",
        "allowedNextStages",
        "actionProgress",
        "resultRefs",
        "createdAt",
        "updatedAt",
    ] {
        if let Some(item) = manifest.get(key) {
            value.insert(key.into(), item.clone());
        }
    }
    value.insert(
        "scope".into(),
        serde_json::json!({"kind":"project", "projectRef":manifest.pointer("/scope/appProjectId")}),
    );
    for (pointer, field, part) in [
        ("currentPlanRevisionId", "currentPlan", "plan"),
        (
            "latestCheckpointRevisionId",
            "latestCheckpoint",
            "checkpoint",
        ),
        ("latestPlanReviewRevisionId", "latestPlanReview", "review"),
        (
            "latestResultReviewRevisionId",
            "latestResultReview",
            "review",
        ),
        (
            "latestCompletionValidationRevisionId",
            "latestCompletionValidation",
            "review",
        ),
        (
            "latestDispositionRevisionId",
            "latestDisposition",
            "disposition",
        ),
    ] {
        if let Some(id) = manifest.get(pointer).and_then(Value::as_str) {
            let child = children
                .get(id)
                .and_then(|item| item.get(part))
                .ok_or_else(|| invalid("project_work_managed_record_invalid"))?;
            value.insert(field.into(), child.clone());
        }
    }
    // Source hydration omits optional effectWatermark/effectBlockers even when
    // the separately verified material proof carries effect facts.
    let view: WorkView = codec::typed(Value::Object(value))?;
    if view.allowed_next_stages != crate::btcc::allowed_next_work_stages(view.current_stage)
        || view.result_refs.len() as u64 != codec::number(manifest, "resultSequence")?
        || view.current_plan.as_ref().map(|plan| plan.revision)
            != manifest
                .get("planRevision")
                .and_then(Value::as_u64)
                .filter(|revision| *revision > 0)
    {
        return Err(invalid("project_work_managed_record_invalid"));
    }
    for binding in manifest
        .get("bindingRefs")
        .and_then(Value::as_array)
        .ok_or_else(|| invalid("project_work_managed_record_invalid"))?
    {
        let id = codec::text(binding, "bindingRevisionId")?;
        let child = children
            .get(id)
            .and_then(|item| item.get("binding"))
            .ok_or_else(|| invalid("project_work_managed_record_invalid"))?;
        let turn = codec::text(binding, "turnId")?;
        let revision = codec::number(binding, "revision")?;
        if child.get("turnId") != binding.get("turnId")
            || child.get("sessionId") != manifest.get("sessionId")
            || child.get("revision") != binding.get("revision")
            || id != codec::record_id("binding", &format!("{turn}\0{revision}\0{}", view.work_id))
        {
            return Err(invalid("project_work_managed_record_invalid"));
        }
    }
    if let Some(plan) = &view.current_plan {
        let keys = plan
            .actions
            .iter()
            .map(|item| &item.action_key)
            .collect::<Vec<_>>();
        let progress = view
            .action_progress
            .iter()
            .map(|item| &item.action_key)
            .collect::<Vec<_>>();
        if plan.objective != view.objective
            || keys != progress
            || keys.iter().collect::<HashSet<_>>().len() != keys.len()
        {
            return Err(invalid("project_work_managed_record_invalid"));
        }
    }
    validation::pointers(manifest, children, &view)?;
    Ok(view)
}

fn managed_invalid() -> ProjectLedgerReadError {
    ProjectLedgerReadError::RecordShow("project_work_managed_record_invalid")
}
