use std::collections::HashMap;

use serde::Serialize;
use serde::de::DeserializeOwned;
use serde_json::{Map, Value};
use sha2::{Digest, Sha256};

use butler_turn::btcc::{
    ActionProgress, DurableWorkStatus, ProjectWorkMaterialSnapshot, ProjectWorkOperationIdentity,
    ProjectWorkOperationKind, ResolvedProjectWorkScope, WorkOrigin, WorkStage, WorkView,
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

/// An operation identity as child records and manifests store it.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct IdentityRecord<'a> {
    kind: &'static str,
    id: &'a str,
    request_sha256: &'a str,
    #[serde(skip_serializing_if = "Option::is_none")]
    mutation_call_id: Option<&'a str>,
}

pub(super) fn identity_value(identity: &ProjectWorkOperationIdentity) -> Value {
    let kind = match identity.kind {
        ProjectWorkOperationKind::MutationCall => "mutation_call",
        ProjectWorkOperationKind::BindingRevision => "binding_revision",
        ProjectWorkOperationKind::CloseoutDiagnostic => "closeout_diagnostic",
        ProjectWorkOperationKind::Abandonment => "abandonment",
        ProjectWorkOperationKind::LegacyImport => "legacy_import",
    };
    let record = IdentityRecord {
        kind,
        id: &identity.id,
        request_sha256: &identity.request_sha256,
        mutation_call_id: identity.mutation_call_id.as_deref(),
    };
    // Strings only: serializing cannot fail.
    serde_json::to_value(record).unwrap_or(Value::Null)
}

pub(super) fn identity_from_value(
    value: &Value,
) -> Result<ProjectWorkOperationIdentity, butler_turn::btcc::BtccError> {
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
    collation: &butler_core::locale::LocaleCollation,
) -> Result<String, butler_turn::btcc::BtccError> {
    let body = super::super::work_json::canonical(value, collation)
        .map_err(super::snapshot::read_error)?;
    Ok(format!("{:x}", Sha256::digest(body.as_bytes())))
}

pub(super) fn assert_material(
    view: &WorkView,
    material: &butler_turn::btcc::ProjectWorkCapturedMaterial,
) -> Result<(), butler_turn::btcc::BtccError> {
    if material.material_fingerprint.len() != 64
        || !material
            .material_fingerprint
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
        || material.material_snapshot.material_fingerprint != material.material_fingerprint
    {
        return Err(invalid("project_work_material_fingerprint_invalid"));
    }
    let expected = butler_turn::btcc::build_project_work_material_snapshot(
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

pub(super) fn typed<T: DeserializeOwned>(value: Value) -> Result<T, butler_turn::btcc::BtccError> {
    serde_json::from_value(value)
        .map_err(|source| invalid("project_work_managed_record_invalid").with_source(source))
}

pub(super) fn text<'a>(
    value: &'a Value,
    name: &str,
) -> Result<&'a str, butler_turn::btcc::BtccError> {
    value
        .get(name)
        .and_then(Value::as_str)
        .ok_or_else(|| invalid("project_work_managed_record_invalid"))
}

pub(super) fn number(value: &Value, name: &str) -> Result<u64, butler_turn::btcc::BtccError> {
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
    pub material: &'a butler_turn::btcc::ProjectWorkCapturedMaterial,
    pub revisions: &'a Value,
}

/// The persisted Project Work manifest (`butler.btcc-project-work.v1`).
/// It is stored as canonical JSON, so field order here is only the order of
/// the in-memory value; revision counters come from the caller and pointers
/// are present only when set.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Manifest<'a, R> {
    schema: &'static str,
    work_id: &'a str,
    session_id: &'a str,
    scope: ManifestScope<'a>,
    origin: &'a WorkOrigin,
    objective: &'a str,
    status: DurableWorkStatus,
    session_head: bool,
    allowed_next_stages: &'a [WorkStage],
    action_progress: &'a [ActionProgress],
    result_refs: &'a [R],
    binding_refs: Value,
    result_sequence: usize,
    material_fingerprint: &'a str,
    material_snapshot: &'a ProjectWorkMaterialSnapshot,
    operation_identity: Value,
    created_at: &'a Value,
    updated_at: &'a str,
    #[serde(flatten)]
    revisions: &'a Map<String, Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    current_stage: Option<WorkStage>,
    #[serde(skip_serializing_if = "Option::is_none")]
    current_plan_revision_id: Option<&'a str>,
    #[serde(skip_serializing_if = "Option::is_none")]
    latest_checkpoint_revision_id: Option<&'a str>,
    #[serde(skip_serializing_if = "Option::is_none")]
    latest_plan_review_revision_id: Option<&'a str>,
    #[serde(skip_serializing_if = "Option::is_none")]
    latest_result_review_revision_id: Option<&'a str>,
    #[serde(skip_serializing_if = "Option::is_none")]
    latest_completion_validation_revision_id: Option<&'a str>,
    #[serde(skip_serializing_if = "Option::is_none")]
    latest_disposition_revision_id: Option<&'a str>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct ManifestScope<'a> {
    app_project_id: &'a str,
    ledger_project_id: &'a str,
}

/// The manifest describing `view` after one operation; the creation time is
/// kept from the prior manifest.
pub(super) fn manifest_for_view(
    input: ManifestViewInput<'_>,
) -> Result<Value, butler_turn::btcc::BtccError> {
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
    let created_at = Value::String(view.created_at.clone());
    let manifest = Manifest {
        schema: "butler.btcc-project-work.v1",
        work_id: &view.work_id,
        session_id: &view.session_id,
        scope: ManifestScope {
            app_project_id: &scope.app_project_id,
            ledger_project_id: &scope.ledger_project_id,
        },
        origin: &view.origin,
        objective: &view.objective,
        status: view.status,
        session_head,
        allowed_next_stages: &view.allowed_next_stages,
        action_progress: &view.action_progress,
        result_refs: &view.result_refs,
        binding_refs,
        result_sequence: view.result_refs.len(),
        material_fingerprint: &material.material_fingerprint,
        material_snapshot: &material.material_snapshot,
        operation_identity: identity_value(identity),
        created_at: prior
            .and_then(|value| value.get("createdAt"))
            .unwrap_or(&created_at),
        updated_at: &view.updated_at,
        revisions: revisions
            .as_object()
            .ok_or_else(|| invalid("project_work_managed_record_invalid"))?,
        current_stage: view.current_stage,
        current_plan_revision_id: view
            .current_plan
            .as_ref()
            .map(|item| item.plan_revision_id.as_str()),
        latest_checkpoint_revision_id: view
            .latest_checkpoint
            .as_ref()
            .map(|item| item.checkpoint_revision_id.as_str()),
        latest_plan_review_revision_id: view
            .latest_plan_review
            .as_ref()
            .map(|item| item.review_revision_id.as_str()),
        latest_result_review_revision_id: view
            .latest_result_review
            .as_ref()
            .map(|item| item.review_revision_id.as_str()),
        latest_completion_validation_revision_id: view
            .latest_completion_validation
            .as_ref()
            .map(|item| item.review_revision_id.as_str()),
        latest_disposition_revision_id: view
            .latest_disposition
            .as_ref()
            .map(|item| item.disposition_revision_id.as_str()),
    };
    serde_json::to_value(manifest)
        .map_err(|source| invalid("project_work_managed_record_invalid").with_source(source))
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
    operation: ProjectLedgerRecordOperation,
    collation: &butler_core::locale::LocaleCollation,
) -> Result<ProjectLedgerRecordUpdate, butler_turn::btcc::BtccError> {
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
    update.operation = Some(operation);
    update.kind = Some(ProjectLedgerRecordKind::Work);
    update.title = Some(format!("Guided Work {work_id}"));
    update.status = Some(official.into());
    update.sections.spec = Some(SPEC.into());
    update.body = Some(
        super::super::work_json::canonical(manifest, collation)
            .map_err(super::snapshot::read_error)?,
    );
    Ok(update)
}
