use serde_json::{Value, json};

use crate::btcc::{
    BtccError, DurableWorkStatus as WorkStatus, ProjectWorkOperationIdentity,
    ProjectWorkOperationKind, WorkView,
};

use super::super::publication::ProjectLedgerRecordKind;
use super::codec;
use super::relation::{has_binding, is_open};
use super::{ProjectWorkRepository, invalid};

impl ProjectWorkRepository {
    pub(super) async fn abandon_for_turn_impl(
        &self,
        turn_id: String,
    ) -> Result<Option<WorkView>, BtccError> {
        let ids = self.ids_for_turn(&turn_id).await?;
        let mut candidate = None;
        for id in ids {
            let snapshot = self.require_current(&id).await?;
            if has_binding(&snapshot, &turn_id) {
                if candidate.is_some() {
                    return Err(invalid("project_work_managed_record_invalid"));
                }
                candidate = Some(snapshot);
            }
        }
        let Some(candidate) = candidate else {
            return Ok(None);
        };
        let relation = self
            .relation_from_ids(&candidate.view.session_id, Some(&turn_id), None)
            .await?;
        let current = relation
            .binding
            .ok_or_else(|| invalid("project_work_turn_binding_stale"))?;
        if current.view.work_id != candidate.view.work_id {
            return Err(invalid("project_work_turn_binding_stale"));
        }
        let revision = current
            .manifest
            .get("bindingRefs")
            .and_then(Value::as_array)
            .and_then(|items| {
                items.iter().find(|item| {
                    item.get("turnId").and_then(Value::as_str) == Some(turn_id.as_str())
                })
            })
            .and_then(|item| item.get("revision"))
            .and_then(Value::as_u64)
            .ok_or_else(|| invalid("project_work_abandonment_binding_missing"))?;
        if current.view.status == WorkStatus::Completed {
            return Ok(Some(current.view));
        }
        if current.view.status == WorkStatus::Abandoned {
            let identity = codec::identity_from_value(
                current
                    .manifest
                    .get("operationIdentity")
                    .ok_or_else(|| invalid("project_work_managed_record_invalid"))?,
            )?;
            self.require_receipt(
                identity,
                current.view.work_id.clone(),
                ProjectLedgerRecordKind::Work,
                None,
            )
            .await?;
            return Ok(Some(current.view));
        }
        let work_id = current.view.work_id.clone();
        let identity = ProjectWorkOperationIdentity {
            kind: ProjectWorkOperationKind::Abandonment,
            id: codec::record_id("abandonment", &format!("{turn_id}\0{work_id}\0{revision}")),
            request_sha256: codec::request_digest(
                &json!({"turnId":turn_id,"workId":work_id,"revision":revision}),
                &self.shared.ledger.collation,
            )?,
            mutation_call_id: None,
        };
        let repo = self.clone();
        let prepare_identity = identity.clone();
        let published = self
            .publish(
                identity,
                move || async move {
                    let fresh = repo.require_current(&work_id).await?;
                    if !is_open(&fresh.view) {
                        return Err(invalid("project_work_not_open"));
                    }
                    let mut view = fresh.view.clone();
                    view.status = WorkStatus::Abandoned;
                    view.updated_at = repo.recorded_at(prepare_identity.clone()).await?;
                    Ok(Some(vec![
                        repo.manifest_update(super::write::ManifestPublicationInput {
                            prior: Some(&fresh),
                            view: &view,
                            identity: &prepare_identity,
                            binding_refs: fresh
                                .manifest
                                .get("bindingRefs")
                                .cloned()
                                .ok_or_else(|| invalid("project_work_managed_record_invalid"))?,
                            session_head: fresh
                                .manifest
                                .get("sessionHead")
                                .and_then(Value::as_bool)
                                .unwrap_or(true),
                            revisions: &codec::revisions(&fresh.manifest),
                            create: false,
                        })
                        .await?,
                    ]))
                },
                true,
            )
            .await?;
        if !published.targets.iter().any(|item| {
            item.kind == ProjectLedgerRecordKind::Work && item.id == current.view.work_id
        }) {
            return Err(invalid("project_work_occurrence_receipt_missing"));
        }
        Ok(Some(
            self.require_current(&current.view.work_id).await?.view,
        ))
    }
}
