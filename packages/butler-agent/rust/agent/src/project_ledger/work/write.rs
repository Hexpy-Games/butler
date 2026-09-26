use serde_json::Value;

use crate::btcc::{BtccError, ProjectWorkMaterialInput, ProjectWorkOperationIdentity, WorkView};

use super::super::publication::{
    ProjectLedgerRecordKind, ProjectLedgerRecordOperation, ProjectLedgerRecordUpdate,
};
use super::super::{committed, records};
use super::codec::{self, Snapshot};
use super::snapshot::read_error;
use super::{ProjectWorkRepository, invalid};

impl ProjectWorkRepository {
    pub(super) async fn view_updates(
        &self,
        input: WorkViewUpdates<'_>,
    ) -> Result<Vec<ProjectLedgerRecordUpdate>, BtccError> {
        let WorkViewUpdates {
            current,
            view,
            identity,
            revisions,
            children,
            create,
            leading,
        } = input;
        let mut updates = leading;
        updates.push(
            self.manifest_update(ManifestPublicationInput {
                prior: Some(current),
                view,
                identity,
                binding_refs: current
                    .manifest
                    .get("bindingRefs")
                    .cloned()
                    .ok_or_else(|| invalid("project_work_managed_record_invalid"))?,
                session_head: current
                    .manifest
                    .get("sessionHead")
                    .and_then(Value::as_bool)
                    .unwrap_or(true),
                revisions,
                create,
            })
            .await?,
        );
        for child in children {
            let (id, kind, title) = child_metadata(&child)?;
            if let Some(update) = self
                .child_update(&view.work_id, &id, kind, title, child)
                .await?
            {
                updates.push(update);
            }
        }
        Ok(updates)
    }

    pub(super) async fn manifest_update(
        &self,
        input: ManifestPublicationInput<'_>,
    ) -> Result<ProjectLedgerRecordUpdate, BtccError> {
        let ManifestPublicationInput {
            prior,
            view,
            identity,
            binding_refs,
            session_head,
            revisions,
            create,
        } = input;
        let material = self
            .shared
            .projection
            .capture_work_material(ProjectWorkMaterialInput {
                candidate: view.clone(),
            })
            .await?;
        codec::assert_material(view, &material)?;
        let manifest = codec::manifest_for_view(codec::ManifestViewInput {
            prior: prior.map(|item| &item.manifest),
            view,
            scope: &self.scope,
            identity,
            binding_refs,
            session_head,
            material: &material,
            revisions,
        })?;
        codec::work_update(&manifest, create, &self.shared.ledger.collation)
    }

    pub(super) async fn child_update(
        &self,
        work_id: &str,
        id: &str,
        kind: ProjectLedgerRecordKind,
        title: String,
        child: Value,
    ) -> Result<Option<ProjectLedgerRecordUpdate>, BtccError> {
        // Source canonicalProjectWorkChildBody hashes the semantic child, then
        // persists that digest beside it. The candidate reader requires both.
        let mut child = child;
        let digest = codec::request_digest(&child, &self.shared.ledger.collation)?;
        child
            .as_object_mut()
            .ok_or_else(|| invalid("project_work_managed_record_invalid"))?
            .insert("recordSha256".into(), Value::String(digest));
        let scope = self.scope.clone();
        let id = id.to_owned();
        let work_id = work_id.to_owned();
        let collation = self.shared.ledger.collation.clone();
        self.shared
            .ledger
            .run(move |_, _| {
                let directory = if kind == ProjectLedgerRecordKind::Plan {
                    "plans"
                } else {
                    "references"
                };
                let other = if kind == ProjectLedgerRecordKind::Plan {
                    "references"
                } else {
                    "plans"
                };
                let path = format!("{directory}/{}.md", id.to_lowercase());
                let other_path = format!("{other}/{}.md", id.to_lowercase());
                if committed::read_selected(&scope.ledger_root, &other_path)?.is_some() {
                    return Err(super::super::ProjectLedgerReadError::RecordShow(
                        "project_work_immutable_identity_ambiguous",
                    ));
                }
                let body = super::super::work_json::canonical(&child, &collation)?;
                if let Some(raw) = committed::read_selected(&scope.ledger_root, &path)? {
                    let data = records::frontmatter(&raw).ok_or(
                        super::super::ProjectLedgerReadError::RecordShow(
                            "project_work_immutable_metadata_conflict",
                        ),
                    )?;
                    let expected_kind = if kind == ProjectLedgerRecordKind::Plan {
                        "plan"
                    } else {
                        "reference"
                    };
                    if data.get("id").and_then(Value::as_str) != Some(&id)
                        || data.get("kind").and_then(Value::as_str) != Some(expected_kind)
                        || data.get("parentId").and_then(Value::as_str) != Some(&work_id)
                        || data.get("spec").and_then(Value::as_str) != Some(codec::SPEC)
                        || data.get("schema").and_then(Value::as_str)
                            != Some(format!("project-ledger.{expected_kind}.v1").as_str())
                    {
                        return Err(super::super::ProjectLedgerReadError::RecordShow(
                            "project_work_immutable_metadata_conflict",
                        ));
                    }
                    if records::frontmatter_body_ref(&raw) != body {
                        return Err(super::super::ProjectLedgerReadError::RecordShow(
                            "project_work_immutable_content_conflict",
                        ));
                    }
                    return Ok(None);
                }
                let mut update = ProjectLedgerRecordUpdate::new(id);
                update.operation = Some(ProjectLedgerRecordOperation::Create);
                update.kind = Some(kind);
                update.parent_id = Some(work_id);
                update.title = Some(title);
                update.status = Some("active".into());
                update.spec = Some(codec::SPEC.into());
                update.body = Some(body);
                Ok(Some(update))
            })
            .await
            .map_err(read_error)
    }
}

pub(super) struct WorkViewUpdates<'a> {
    pub current: &'a Snapshot,
    pub view: &'a WorkView,
    pub identity: &'a ProjectWorkOperationIdentity,
    pub revisions: &'a Value,
    pub children: Vec<Value>,
    pub create: bool,
    pub leading: Vec<ProjectLedgerRecordUpdate>,
}

pub(super) struct ManifestPublicationInput<'a> {
    pub prior: Option<&'a Snapshot>,
    pub view: &'a WorkView,
    pub identity: &'a ProjectWorkOperationIdentity,
    pub binding_refs: Value,
    pub session_head: bool,
    pub revisions: &'a Value,
    pub create: bool,
}

pub(super) fn child_metadata(
    child: &Value,
) -> Result<(String, ProjectLedgerRecordKind, String), BtccError> {
    match codec::text(child, "schema")? {
        "butler.btcc-project-work-plan.v1" => {
            let plan = child
                .get("plan")
                .ok_or_else(|| invalid("project_work_managed_record_invalid"))?;
            Ok((
                codec::text(plan, "planRevisionId")?.into(),
                ProjectLedgerRecordKind::Plan,
                format!("Guided Work Plan {}", codec::number(plan, "revision")?),
            ))
        }
        "butler.btcc-project-work-checkpoint.v1" => {
            let item = child
                .get("checkpoint")
                .ok_or_else(|| invalid("project_work_managed_record_invalid"))?;
            Ok((
                codec::text(item, "checkpointRevisionId")?.into(),
                ProjectLedgerRecordKind::Reference,
                format!(
                    "Guided Work checkpoint {}",
                    codec::number(item, "revision")?
                ),
            ))
        }
        "butler.btcc-project-work-review.v1" => {
            let item = child
                .get("review")
                .ok_or_else(|| invalid("project_work_managed_record_invalid"))?;
            Ok((
                codec::text(item, "reviewRevisionId")?.into(),
                ProjectLedgerRecordKind::Reference,
                format!("Guided Work {} Review", codec::text(item, "subject")?),
            ))
        }
        "butler.btcc-project-work-disposition.v1" => {
            let item = child
                .get("disposition")
                .ok_or_else(|| invalid("project_work_managed_record_invalid"))?;
            Ok((
                codec::text(item, "dispositionRevisionId")?.into(),
                ProjectLedgerRecordKind::Reference,
                format!(
                    "Guided Work disposition {}",
                    codec::number(item, "revision")?
                ),
            ))
        }
        "butler.btcc-project-work-result-reference.v1" => {
            let item = child
                .get("result")
                .ok_or_else(|| invalid("project_work_managed_record_invalid"))?;
            Ok((
                codec::text(item, "resultRef")?.into(),
                ProjectLedgerRecordKind::Reference,
                format!("Guided Work Result {}", codec::number(item, "sequence")?),
            ))
        }
        "butler.btcc-project-work-binding.v1" => {
            let item = child
                .get("binding")
                .ok_or_else(|| invalid("project_work_managed_record_invalid"))?;
            Ok((
                codec::text(item, "bindingRevisionId")?.into(),
                ProjectLedgerRecordKind::Reference,
                format!(
                    "Guided Work Turn binding {}",
                    codec::number(item, "revision")?
                ),
            ))
        }
        _ => Err(invalid("project_work_managed_record_invalid")),
    }
}
