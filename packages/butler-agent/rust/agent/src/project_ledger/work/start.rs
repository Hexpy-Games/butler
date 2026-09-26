use serde_json::{Value, json};

use crate::btcc::{
    BtccError, DurableWorkStatus as WorkStatus, ProjectWorkOperationIdentity, StartWorkCommand,
    WorkOrigin, WorkScope, WorkView,
};

use super::super::publication::{ProjectLedgerRecordKind, ProjectLedgerRecordUpdate};
use super::codec;
use super::relation::is_open;
use super::{ProjectWorkRepository, invalid};

impl ProjectWorkRepository {
    pub(super) async fn start_impl(
        &self,
        command: StartWorkCommand,
    ) -> Result<WorkView, BtccError> {
        self.assert_scope(&command.input.scope)?;
        let identity =
            codec::mutation_identity(&command.input.mutation_call_id, &command.request_sha256);
        let work_id = codec::record_id("work", &command.input.mutation_call_id);
        let repo = self.clone();
        let prepare_identity = identity.clone();
        let requested_id = work_id.clone();
        self.publish(identity, move || async move {
            let relation = repo.relation(&command.input.scope).await?;
            if relation.binding.is_some() { return Err(invalid("project_work_turn_already_bound")); }
            if repo.read_current(&requested_id).await?.is_some() {
                return Err(invalid("project_work_occurrence_receipt_missing"));
            }
            let at = repo.recorded_at(prepare_identity.clone()).await?;
            let original = repo.shared.projection.load_original_request(command.input.scope.clone()).await?;
            if original.turn_id != command.input.scope.turn_id {
                return Err(invalid("project_work_origin_turn_mismatch"));
            }
            let view = opening_view(&repo, &command.input.scope, &command.input.objective, &requested_id, &original.message_id, &at);
            let (binding_id, binding) = binding_child(&command.input.scope.turn_id, &command.input.scope.session_id, &requested_id, 1, &prepare_identity, &at);
            let mut updates = Vec::<ProjectLedgerRecordUpdate>::new();
            if let Some(prior) = relation.head {
                let mut prior_view = prior.view.clone();
                if is_open(&prior_view) { prior_view.status = WorkStatus::Abandoned; }
                prior_view.updated_at = at.clone();
                updates.push(repo.manifest_update(super::write::ManifestPublicationInput {
                    prior: Some(&prior),
                    view: &prior_view,
                    identity: &prepare_identity,
                    binding_refs: prior.manifest.get("bindingRefs").cloned()
                        .ok_or_else(|| invalid("project_work_managed_record_invalid"))?,
                    session_head: false,
                    revisions: &codec::revisions(&prior.manifest),
                    create: false,
                }).await?);
            }
            updates.push(repo.manifest_update(super::write::ManifestPublicationInput {
                prior: None,
                view: &view,
                identity: &prepare_identity,
                binding_refs: json!([{"bindingRevisionId":binding_id,"turnId":command.input.scope.turn_id,"revision":1}]),
                session_head: true,
                revisions: &json!({"planRevision":0,"checkpointRevision":0,"checkpointResultSequence":0,"reviewRevision":0,"dispositionRevision":0}),
                create: true,
            }).await?);
            if let Some(child) = repo.child_update(&requested_id, &binding_id, ProjectLedgerRecordKind::Reference,
                "Guided Work Turn binding 1".into(), binding).await? {
                updates.push(child);
            }
            Ok(Some(updates))
        }, true).await?;
        Ok(self.require_current(&work_id).await?.view)
    }
}

pub(super) fn binding_child(
    turn_id: &str,
    session_id: &str,
    work_id: &str,
    revision: u64,
    identity: &ProjectWorkOperationIdentity,
    at: &str,
) -> (String, Value) {
    let id = codec::record_id("binding", &format!("{turn_id}\0{revision}\0{work_id}"));
    let child = json!({
        "schema": "butler.btcc-project-work-binding.v1",
        "workId": work_id,
        "operationIdentity": codec::identity_value(identity),
        "binding": {
            "bindingRevisionId": id, "turnId":turn_id, "sessionId":session_id,
            "revision":revision, "boundAt":at,
        },
    });
    (id, child)
}

pub(super) fn opening_view(
    repo: &ProjectWorkRepository,
    scope: &crate::btcc::WorkTurnScope,
    objective: &str,
    work_id: &str,
    message_id: &str,
    at: &str,
) -> WorkView {
    WorkView {
        work_id: work_id.into(),
        session_id: scope.session_id.clone(),
        scope: WorkScope::Project {
            project_ref: repo.scope.app_project_id.clone(),
        },
        origin: WorkOrigin {
            turn_id: scope.turn_id.clone(),
            message_id: message_id.into(),
        },
        objective: objective.into(),
        status: WorkStatus::Open,
        current_stage: None,
        allowed_next_stages: crate::btcc::allowed_next_work_stages(None),
        action_progress: Vec::new(),
        current_plan: None,
        latest_checkpoint: None,
        latest_plan_review: None,
        latest_result_review: None,
        latest_completion_validation: None,
        latest_disposition: None,
        effect_watermark: None,
        effect_blockers: None,
        result_refs: Vec::new(),
        created_at: at.into(),
        updated_at: at.into(),
    }
}
