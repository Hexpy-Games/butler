use serde_json::Value;

use butler_turn::btcc::{
    BtccError, ProjectWorkMaterialInput, ProjectWorkOperationIdentity, WorkView,
};

use super::super::ProjectLedgerReadError;
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
            operation,
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
                operation,
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
            operation,
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
        codec::work_update(&manifest, operation, &self.shared.ledger.collation)
    }

    /// The create update for an immutable child record, or `None` when the
    /// identical child already exists; a conflicting one is an error.
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
        let child = ChildRecord {
            id: id.to_owned(),
            work_id: work_id.to_owned(),
            kind,
            title,
            value: child,
        };
        let collation = self.shared.ledger.collation.clone();
        self.shared
            .ledger
            .run(move |_, _| child.update(&scope.ledger_root, &collation))
            .await
            .map_err(read_error)
    }
}

/// An immutable Work child to publish as a plan or reference record.
struct ChildRecord {
    id: String,
    work_id: String,
    kind: ProjectLedgerRecordKind,
    title: String,
    value: Value,
}

impl ChildRecord {
    fn update(
        self,
        root: &std::path::Path,
        collation: &butler_core::locale::LocaleCollation,
    ) -> Result<Option<ProjectLedgerRecordUpdate>, ProjectLedgerReadError> {
        let (directory, other, expected_kind) = if self.kind == ProjectLedgerRecordKind::Plan {
            ("plans", "references", "plan")
        } else {
            ("references", "plans", "reference")
        };
        let file = format!("{}.md", self.id.to_lowercase());
        if committed::read_selected(root, &format!("{other}/{file}"))?.is_some() {
            return Err(ProjectLedgerReadError::record_show(
                "project_work_immutable_identity_ambiguous",
            ));
        }
        let body = super::super::work_json::canonical(&self.value, collation)?;
        if let Some(raw) = committed::read_selected(root, &format!("{directory}/{file}"))? {
            self.same_as_existing(&raw, expected_kind, &body)?;
            return Ok(None);
        }
        let mut update = ProjectLedgerRecordUpdate::new(self.id);
        update.operation = Some(ProjectLedgerRecordOperation::Create);
        update.kind = Some(self.kind);
        update.parent_id = Some(self.work_id);
        update.title = Some(self.title);
        update.status = Some("active".into());
        update.sections.spec = Some(codec::SPEC.into());
        update.body = Some(body);
        Ok(Some(update))
    }

    /// The existing record has this child's identity and exact body.
    fn same_as_existing(
        &self,
        raw: &str,
        expected_kind: &str,
        body: &str,
    ) -> Result<(), ProjectLedgerReadError> {
        let conflict =
            || ProjectLedgerReadError::record_show("project_work_immutable_metadata_conflict");
        let data = records::frontmatter(raw).ok_or_else(conflict)?;
        let text = |key: &str| data.get(key).and_then(Value::as_str);
        if text("id") != Some(&self.id)
            || text("kind") != Some(expected_kind)
            || text("parentId") != Some(&self.work_id)
            || text("spec") != Some(codec::SPEC)
            || text("schema") != Some(format!("project-ledger.{expected_kind}.v1").as_str())
        {
            return Err(conflict());
        }
        if records::frontmatter_body_ref(raw) != body {
            return Err(ProjectLedgerReadError::record_show(
                "project_work_immutable_content_conflict",
            ));
        }
        Ok(())
    }
}

pub(super) struct WorkViewUpdates<'a> {
    pub current: &'a Snapshot,
    pub view: &'a WorkView,
    pub identity: &'a ProjectWorkOperationIdentity,
    pub revisions: &'a codec::Revisions,
    pub children: Vec<Value>,
    pub operation: ProjectLedgerRecordOperation,
    pub leading: Vec<ProjectLedgerRecordUpdate>,
}

pub(super) struct ManifestPublicationInput<'a> {
    pub prior: Option<&'a Snapshot>,
    pub view: &'a WorkView,
    pub identity: &'a ProjectWorkOperationIdentity,
    pub binding_refs: Value,
    pub session_head: bool,
    pub revisions: &'a codec::Revisions,
    pub operation: ProjectLedgerRecordOperation,
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
