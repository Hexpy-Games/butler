use std::collections::HashMap;

use serde::de::DeserializeOwned;
use serde_json::{Map, Value};
use sha2::{Digest, Sha256};

use crate::btcc::{
    ProjectWorkOperationIdentity, ProjectWorkOperationKind, ResolvedProjectWorkScope, WorkView,
};

use super::super::publication::{
    ProjectLedgerRecordKind, ProjectLedgerRecordOperation, ProjectLedgerRecordUpdate,
};
use super::invalid;

pub(super) const SPEC: &str = "SPEC-BTCC-R3-WORK-LEDGER-SCOPE";

#[derive(Clone)]
pub(in crate::project_ledger) struct Snapshot {
    pub manifest: Value,
    pub view: WorkView,
    pub children: HashMap<String, Value>,
}

pub(super) fn record_id(kind: &str, identity: &str) -> String {
    let payload = format!("btcc-guided-work.v1\0{kind}\0{identity}");
    format!("guided-{kind}-{:x}", Sha256::digest(payload.as_bytes()))
}

pub(super) fn mutation_identity(id: &str, digest: &str) -> ProjectWorkOperationIdentity {
    ProjectWorkOperationIdentity {
        kind: ProjectWorkOperationKind::MutationCall,
        id: id.to_owned(),
        request_sha256: digest.to_owned(),
        mutation_call_id: Some(id.to_owned()),
    }
}

pub(super) fn identity_value(identity: &ProjectWorkOperationIdentity) -> Value {
    let kind = match identity.kind {
        ProjectWorkOperationKind::MutationCall => "mutation_call",
        ProjectWorkOperationKind::BindingRevision => "binding_revision",
        ProjectWorkOperationKind::CloseoutDiagnostic => "closeout_diagnostic",
        ProjectWorkOperationKind::Abandonment => "abandonment",
        ProjectWorkOperationKind::LegacyImport => "legacy_import",
    };
    let mut value = serde_json::json!({
        "kind": kind, "id": identity.id, "requestSha256": identity.request_sha256,
    });
    if let Some(call) = &identity.mutation_call_id {
        value["mutationCallId"] = Value::String(call.clone());
    }
    value
}

pub(super) fn identity_from_value(
    value: &Value,
) -> Result<ProjectWorkOperationIdentity, crate::btcc::BtccError> {
    let kind = match text(value, "kind")? {
        "mutation_call" => ProjectWorkOperationKind::MutationCall,
        "binding_revision" => ProjectWorkOperationKind::BindingRevision,
        "closeout_diagnostic" => ProjectWorkOperationKind::CloseoutDiagnostic,
        "abandonment" => ProjectWorkOperationKind::Abandonment,
        "legacy_import" => ProjectWorkOperationKind::LegacyImport,
        _ => return Err(invalid("project_work_managed_record_invalid")),
    };
    Ok(ProjectWorkOperationIdentity {
        kind,
        id: text(value, "id")?.into(),
        request_sha256: text(value, "requestSha256")?.into(),
        mutation_call_id: value
            .get("mutationCallId")
            .and_then(Value::as_str)
            .map(str::to_owned),
    })
}

pub(super) fn request_digest(
    value: &Value,
    collation: &crate::locale::LocaleCollation,
) -> Result<String, crate::btcc::BtccError> {
    let body = super::super::work_json::canonical(value, collation)
        .map_err(super::snapshot::read_error)?;
    Ok(format!("{:x}", Sha256::digest(body.as_bytes())))
}

pub(super) fn assert_material(
    view: &WorkView,
    material: &crate::btcc::ProjectWorkCapturedMaterial,
) -> Result<(), crate::btcc::BtccError> {
    if material.material_fingerprint.len() != 64
        || !material
            .material_fingerprint
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
        || material.material_snapshot.material_fingerprint != material.material_fingerprint
    {
        return Err(invalid("project_work_material_fingerprint_invalid"));
    }
    let expected = crate::btcc::build_project_work_material_snapshot(
        view,
        material.material_fingerprint.clone(),
        material.material_snapshot.effect_watermark.clone(),
        material.material_snapshot.effect_blockers.clone(),
    )?;
    if expected != material.material_snapshot {
        return Err(invalid("project_work_managed_record_invalid"));
    }
    Ok(())
}

pub(super) fn typed<T: DeserializeOwned>(value: Value) -> Result<T, crate::btcc::BtccError> {
    serde_json::from_value(value).map_err(|_| invalid("project_work_managed_record_invalid"))
}

pub(super) fn text<'a>(value: &'a Value, name: &str) -> Result<&'a str, crate::btcc::BtccError> {
    value
        .get(name)
        .and_then(Value::as_str)
        .ok_or_else(|| invalid("project_work_managed_record_invalid"))
}

pub(super) fn number(value: &Value, name: &str) -> Result<u64, crate::btcc::BtccError> {
    value
        .get(name)
        .and_then(Value::as_u64)
        .ok_or_else(|| invalid("project_work_managed_record_invalid"))
}

pub(super) struct ManifestViewInput<'a> {
    pub prior: Option<&'a Value>,
    pub view: &'a WorkView,
    pub scope: &'a ResolvedProjectWorkScope,
    pub identity: &'a ProjectWorkOperationIdentity,
    pub binding_refs: Value,
    pub session_head: bool,
    pub material: &'a crate::btcc::ProjectWorkCapturedMaterial,
    pub revisions: &'a Value,
}

pub(super) fn manifest_for_view(
    input: ManifestViewInput<'_>,
) -> Result<Value, crate::btcc::BtccError> {
    let ManifestViewInput {
        prior,
        view,
        scope,
        identity,
        binding_refs,
        session_head,
        material,
        revisions,
    } = input;
    let mut manifest = serde_json::json!({
        "schema": "butler.btcc-project-work.v1",
        "workId": view.work_id,
        "sessionId": view.session_id,
        "scope": {"appProjectId": scope.app_project_id, "ledgerProjectId": scope.ledger_project_id},
        "origin": view.origin,
        "objective": view.objective,
        "status": view.status,
        "sessionHead": session_head,
        "allowedNextStages": view.allowed_next_stages,
        "actionProgress": view.action_progress,
        "resultRefs": view.result_refs,
        "bindingRefs": binding_refs,
        "resultSequence": view.result_refs.len(),
        "materialFingerprint": material.material_fingerprint,
        "materialSnapshot": material.material_snapshot,
        "operationIdentity": identity_value(identity),
        "createdAt": prior.and_then(|v| v.get("createdAt")).unwrap_or(&Value::String(view.created_at.clone())),
        "updatedAt": view.updated_at,
    });
    let object = manifest
        .as_object_mut()
        .ok_or_else(|| invalid("project_work_managed_record_invalid"))?;
    for (key, value) in revisions
        .as_object()
        .ok_or_else(|| invalid("project_work_managed_record_invalid"))?
    {
        object.insert(key.clone(), value.clone());
    }
    for (key, value) in [
        (
            "currentStage",
            serde_json::to_value(view.current_stage).ok(),
        ),
        (
            "currentPlanRevisionId",
            view.current_plan
                .as_ref()
                .map(|item| Value::String(item.plan_revision_id.clone())),
        ),
        (
            "latestCheckpointRevisionId",
            view.latest_checkpoint
                .as_ref()
                .map(|item| Value::String(item.checkpoint_revision_id.clone())),
        ),
        (
            "latestPlanReviewRevisionId",
            view.latest_plan_review
                .as_ref()
                .map(|item| Value::String(item.review_revision_id.clone())),
        ),
        (
            "latestResultReviewRevisionId",
            view.latest_result_review
                .as_ref()
                .map(|item| Value::String(item.review_revision_id.clone())),
        ),
        (
            "latestCompletionValidationRevisionId",
            view.latest_completion_validation
                .as_ref()
                .map(|item| Value::String(item.review_revision_id.clone())),
        ),
        (
            "latestDispositionRevisionId",
            view.latest_disposition
                .as_ref()
                .map(|item| Value::String(item.disposition_revision_id.clone())),
        ),
    ] {
        if let Some(value) = value.filter(|item| !item.is_null()) {
            object.insert(key.into(), value);
        }
    }
    Ok(manifest)
}

pub(super) fn revisions(manifest: &Value) -> Value {
    let mut values = Map::new();
    for key in [
        "planRevision",
        "checkpointRevision",
        "checkpointResultSequence",
        "reviewRevision",
        "dispositionRevision",
    ] {
        values.insert(
            key.into(),
            manifest.get(key).cloned().unwrap_or(Value::from(0)),
        );
    }
    Value::Object(values)
}

pub(super) fn work_update(
    manifest: &Value,
    create: bool,
    collation: &crate::locale::LocaleCollation,
) -> Result<ProjectLedgerRecordUpdate, crate::btcc::BtccError> {
    let work_id = text(manifest, "workId")?;
    let status = text(manifest, "status")?;
    let official = match status {
        "completed" => "review",
        "abandoned" => "cancelled",
        "blocked" => "blocked",
        "open" => "in_progress",
        _ => return Err(invalid("project_work_managed_record_invalid")),
    };
    let mut update = ProjectLedgerRecordUpdate::new(work_id.into());
    update.operation = Some(if create {
        ProjectLedgerRecordOperation::Create
    } else {
        ProjectLedgerRecordOperation::Update
    });
    update.kind = Some(ProjectLedgerRecordKind::Work);
    update.title = Some(format!("Guided Work {work_id}"));
    update.status = Some(official.into());
    update.spec = Some(SPEC.into());
    update.body = Some(
        super::super::work_json::canonical(manifest, collation)
            .map_err(super::snapshot::read_error)?,
    );
    Ok(update)
}
