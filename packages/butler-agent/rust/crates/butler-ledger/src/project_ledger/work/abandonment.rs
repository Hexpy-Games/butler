use serde_json::{Value, json};

use butler_turn::btcc::{
    BtccError, DurableWorkStatus as WorkStatus, ProjectWorkOperationIdentity,
    ProjectWorkOperationKind, WorkView,
};

use super::super::publication::{ProjectLedgerRecordKind, ProjectLedgerRecordUpdate};
use super::codec::{self, Snapshot};
use super::relation::{has_binding, is_open};
use super::{ProjectWorkRepository, invalid};

impl ProjectWorkRepository {
    /// Abandons the open Work bound to `turn_id`; completed or already
    /// abandoned Work is returned as it is.
    pub(super) async fn abandon_for_turn_impl(
        &self,
        turn_id: String,
    ) -> Result<Option<WorkView>, BtccError> {
        let Some(candidate) = self.bound_candidate(&turn_id).await? else {
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
        let revision = binding_revision(&current, &turn_id)?;
        match current.view.status {
            WorkStatus::Completed => return Ok(Some(current.view)),
            WorkStatus::Abandoned => {
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
            WorkStatus::Open | WorkStatus::Blocked => {}
        }
        self.publish_abandonment(&turn_id, &current.view.work_id, revision)
            .await
            .map(Some)
    }

    /// The single Work carrying a binding for `turn_id`, if any.
    async fn bound_candidate(&self, turn_id: &str) -> Result<Option<Snapshot>, BtccError> {
        let mut candidate = None;
        for id in self.ids_for_turn(turn_id).await? {
            let snapshot = self.require_current(&id).await?;
            if !has_binding(&snapshot, turn_id) {
                continue;
            }
            if candidate.is_some() {
                return Err(invalid("project_work_managed_record_invalid"));
            }
            candidate = Some(snapshot);
        }
        Ok(candidate)
    }

    async fn publish_abandonment(
        &self,
        turn_id: &str,
        work_id: &str,
        revision: u64,
    ) -> Result<WorkView, BtccError> {
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
        let target = work_id.to_owned();
        let published = self
            .publish(
                identity,
                move || async move {
                    repo.abandonment_update(&target, &prepare_identity)
                        .await
                        .map(|update| Some(vec![update]))
                },
                true,
            )
            .await?;
        if !published
            .targets
            .iter()
            .any(|item| item.kind == ProjectLedgerRecordKind::Work && item.id == work_id)
        {
            return Err(invalid("project_work_occurrence_receipt_missing"));
        }
        Ok(self.require_current(work_id).await?.view)
    }

    /// The manifest of the still-open Work, marked abandoned.
    async fn abandonment_update(
        &self,
        work_id: &str,
        identity: &ProjectWorkOperationIdentity,
    ) -> Result<ProjectLedgerRecordUpdate, BtccError> {
        let fresh = self.require_current(work_id).await?;
        if !is_open(&fresh.view) {
            return Err(invalid("project_work_not_open"));
        }
        let mut view = fresh.view.clone();
        view.status = WorkStatus::Abandoned;
        view.updated_at = self.recorded_at(identity.clone()).await?;
        self.manifest_update(super::write::ManifestPublicationInput {
            prior: Some(&fresh),
            view: &view,
            identity,
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
        .await
    }
}

/// The revision of `turn_id`'s binding in the manifest.
fn binding_revision(current: &Snapshot, turn_id: &str) -> Result<u64, BtccError> {
    current
        .manifest
        .get("bindingRefs")
        .and_then(Value::as_array)
        .and_then(|items| {
            items
                .iter()
                .find(|item| item.get("turnId").and_then(Value::as_str) == Some(turn_id))
        })
        .and_then(|item| item.get("revision"))
        .and_then(Value::as_u64)
        .ok_or_else(|| invalid("project_work_abandonment_binding_missing"))
}
