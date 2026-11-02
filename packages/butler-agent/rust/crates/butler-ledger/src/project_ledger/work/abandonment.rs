use serde_json::{Value, json};

use butler_turn::btcc::{
    BtccError, DurableWorkStatus as WorkStatus, ProjectWorkOperationIdentity,
    ProjectWorkOperationKind, WorkStage, WorkView,
};

use super::super::publication::ProjectLedgerRecordOperation;
use super::super::publication::{ProjectLedgerRecordKind, ProjectLedgerRecordUpdate};
use super::codec::{self, Snapshot};
use super::publication::Projection;
use super::relation::is_open;
use super::{ProjectWorkRepository, invalid};

impl ProjectWorkRepository {
    /// Abandons the open Work bound to `turn_id`; completed or already
    /// abandoned Work is returned as it is.
    pub(super) async fn abandon_for_turn_impl(
        &self,
        turn_id: String,
    ) -> Result<Option<WorkView>, BtccError> {
        let ids = self.ids_for_turn(&turn_id).await?;
        let Some(candidate) = self.single_binding(ids, &turn_id).await? else {
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
        let turn = turn_id.to_owned();
        let published = self
            .publish(
                identity,
                move || async move {
                    repo.abandonment_updates(&target, &turn, &prepare_identity)
                        .await
                        .map(Some)
                },
                Projection::Recover,
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
    async fn abandonment_updates(
        &self,
        work_id: &str,
        turn: &str,
        identity: &ProjectWorkOperationIdentity,
    ) -> Result<Vec<ProjectLedgerRecordUpdate>, BtccError> {
        let fresh = self.require_current(work_id).await?;
        if !is_open(&fresh.view) {
            return Err(invalid("project_work_not_open"));
        }
        let mut view = fresh.view.clone();
        view.status = WorkStatus::Abandoned;
        // The earlier disposition describes its old material and stays in history.
        view.latest_disposition = None;
        view.updated_at = self.recorded_at(identity.clone()).await?;
        let mut revisions = codec::revisions(&fresh.manifest);
        let children = closing_checkpoint(&fresh, &mut view, identity, turn, &mut revisions)?;
        self.view_updates(super::write::WorkViewUpdates {
            current: &fresh,
            view: &view,
            identity,
            revisions: &revisions,
            children,
            operation: ProjectLedgerRecordOperation::Update,
            leading: Vec::new(),
        })
        .await
    }
}

/// Close current actions in a new immutable checkpoint with its manifest.
fn closing_checkpoint(
    current: &Snapshot,
    view: &mut WorkView,
    identity: &ProjectWorkOperationIdentity,
    turn: &str,
    revisions: &mut codec::Revisions,
) -> Result<Vec<Value>, BtccError> {
    let Some(plan) = &view.current_plan else {
        return Ok(Vec::new());
    };
    let plan_id = plan.plan_revision_id.clone();
    for action in &mut view.action_progress {
        if !matches!(
            action.status,
            butler_turn::btcc::ActionStatus::Done | butler_turn::btcc::ActionStatus::Skipped
        ) {
            action.status = butler_turn::btcc::ActionStatus::Skipped;
            action.note = Some("Work ended.".into());
        }
    }
    view.current_stage = Some(WorkStage::Reporting);
    view.allowed_next_stages = butler_turn::btcc::allowed_next_work_stages(view.current_stage);
    revisions.checkpoint_revision += 1;
    revisions.checkpoint_result_sequence = view.result_refs.len() as u64;
    let child = super::progress::checkpoint_child(super::progress::CheckpointChildInput {
        current,
        turn_id: turn,
        identity,
        at: &view.updated_at,
        revision: revisions.checkpoint_revision,
        stage: WorkStage::Reporting,
        plan_id: &plan_id,
        progress: &view.action_progress,
        summary: "Work ended.",
        next: "",
        checkpoint_identity: &identity.id,
    });
    view.latest_checkpoint = Some(codec::typed(child["checkpoint"].clone())?);
    Ok(vec![child])
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
