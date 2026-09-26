use std::collections::HashMap;

use serde_json::{Value, json};

use crate::btcc::{
    BtccError, Checkpoint, CheckpointCommand, DurableWorkStatus as WorkStatus,
    ProjectWorkOperationIdentity, ReplacePlanCommand, WorkPlan, WorkStage, WorkView,
};

use super::super::publication::ProjectLedgerRecordUpdate;
use super::codec::{self, Snapshot};
use super::publication::published_work_id;
use super::relation::is_open;
use super::start::{binding_child, opening_view};
use super::{ProjectWorkRepository, invalid};

struct PlanUpdatesInput<'a> {
    current: &'a Snapshot,
    command: &'a ReplacePlanCommand,
    identity: &'a ProjectWorkOperationIdentity,
    at: &'a str,
    opening: Option<Value>,
    create: bool,
    leading: Vec<ProjectLedgerRecordUpdate>,
}

impl ProjectWorkRepository {
    pub(super) async fn replace_plan_impl(
        &self,
        command: ReplacePlanCommand,
    ) -> Result<WorkView, BtccError> {
        self.assert_scope(&command.input.scope)?;
        let identity =
            codec::mutation_identity(&command.input.mutation_call_id, &command.request_sha256);
        let target_id = command
            .expected_work_id
            .clone()
            .unwrap_or_else(|| codec::record_id("work", &command.input.mutation_call_id));
        let repo = self.clone();
        let prepare_identity = identity.clone();
        self.publish(identity, move || async move {
            let relation = repo.relation(&command.input.scope).await?;
            if command.start_new && relation.binding.is_some() { return Err(invalid("project_work_turn_already_bound")); }
            let current = if command.start_new { None } else { repo.current_for_scope(&command.input.scope).await? };
            let at = repo.recorded_at(prepare_identity.clone()).await?;
            let (current, opening, create, leading) = if let Some(current) = current {
                (current, None, false, Vec::new())
            } else {
                let work_id = codec::record_id("work", &command.input.mutation_call_id);
                let original = repo.shared.projection.load_original_request(command.input.scope.clone()).await?;
                if original.turn_id != command.input.scope.turn_id { return Err(invalid("project_work_origin_turn_mismatch")); }
                let (binding_id, child) = binding_child(&command.input.scope.turn_id, &command.input.scope.session_id, &work_id, 1, &prepare_identity, &at);
                let view = opening_view(&repo, &command.input.scope, &command.input.objective, &work_id, &original.message_id, &at);
                let material = repo.shared.projection.capture_work_material(crate::btcc::ProjectWorkMaterialInput {
                    candidate: view.clone(),
                }).await?;
                codec::assert_material(&view, &material)?;
                let manifest = codec::manifest_for_view(codec::ManifestViewInput {
                    prior: None,
                    view: &view,
                    scope: &repo.scope,
                    identity: &prepare_identity,
                    binding_refs: json!([{"bindingRevisionId":binding_id,"turnId":command.input.scope.turn_id,"revision":1}]),
                    session_head: true,
                    material: &material,
                    revisions: &empty_revisions(),
                })?;
                let virtual_current = Snapshot { manifest, view, children: HashMap::new() };
                let mut leading = Vec::new();
                if let Some(prior) = relation.head {
                    let mut prior_view = prior.view.clone();
                    if is_open(&prior_view) { prior_view.status = WorkStatus::Abandoned; }
                    prior_view.updated_at = at.clone();
                    leading.push(repo.manifest_update(super::write::ManifestPublicationInput {
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
                (virtual_current, Some(child), true, leading)
            };
            repo.plan_updates(PlanUpdatesInput {
                current: &current,
                command: &command,
                identity: &prepare_identity,
                at: &at,
                opening,
                create,
                leading,
            }).await.map(Some)
        }, true).await?;
        Ok(self.require_current(&target_id).await?.view)
    }

    async fn plan_updates(
        &self,
        input: PlanUpdatesInput<'_>,
    ) -> Result<Vec<ProjectLedgerRecordUpdate>, BtccError> {
        let PlanUpdatesInput {
            current,
            command,
            identity,
            at,
            opening,
            create,
            leading,
        } = input;
        if command
            .expected_work_id
            .as_ref()
            .is_some_and(|id| id != &current.view.work_id)
        {
            return Err(invalid("project_work_expected_work_mismatch"));
        }
        if command.expected_progress_revision.is_some_and(|revision| {
            Some(revision)
                != current
                    .manifest
                    .get("checkpointRevision")
                    .and_then(Value::as_u64)
        }) {
            return Err(invalid("project_work_progress_revision_mismatch"));
        }
        let plan_revision = codec::number(&current.manifest, "planRevision")? + 1;
        let plan_id = codec::record_id("plan", &command.input.mutation_call_id);
        let plan: WorkPlan = codec::typed(json!({
            "planRevisionId":plan_id, "revision":plan_revision,
            "objective":command.input.objective, "governingRefs":command.governing_refs,
            "executionMode":command.input.execution_mode, "actions":command.input.actions,
            "checks":command.input.checks, "originTurnId":command.input.scope.turn_id, "createdAt":at,
        }))?;
        let mut children = vec![
            json!({"schema":"butler.btcc-project-work-plan.v1","workId":current.view.work_id,
            "operationIdentity":codec::identity_value(identity),"plan":plan}),
        ];
        let mut checkpoint_revision = codec::number(&current.manifest, "checkpointRevision")?;
        let summary = &command.input.objective;
        let next = command
            .input
            .actions
            .first()
            .map(|item| item.description.as_str())
            .unwrap_or("");
        if command.opening_plan {
            checkpoint_revision += 1;
            children.push(checkpoint_child(CheckpointChildInput {
                current,
                turn_id: &command.input.scope.turn_id,
                identity,
                at,
                revision: checkpoint_revision,
                stage: WorkStage::Conception,
                plan_id: &plan_id,
                progress: &command.action_progress,
                summary,
                next,
                checkpoint_identity: &format!("{}\0conception", command.input.mutation_call_id),
            })?);
        }
        checkpoint_revision += 1;
        let planning = checkpoint_child(CheckpointChildInput {
            current,
            turn_id: &command.input.scope.turn_id,
            identity,
            at,
            revision: checkpoint_revision,
            stage: WorkStage::Planning,
            plan_id: &plan_id,
            progress: &command.action_progress,
            summary,
            next,
            checkpoint_identity: &format!("{}\0plan", command.input.mutation_call_id),
        })?;
        let checkpoint: Checkpoint = codec::typed(
            planning
                .get("checkpoint")
                .cloned()
                .ok_or_else(|| invalid("project_work_managed_record_invalid"))?,
        )?;
        children.push(planning);
        if let Some(opening) = opening {
            children.insert(0, opening);
        }
        let mut view = current.view.clone();
        view.objective = command.input.objective.clone();
        view.status = status_for_progress(&command.action_progress);
        view.current_stage = Some(WorkStage::Planning);
        view.allowed_next_stages = crate::btcc::allowed_next_work_stages(Some(WorkStage::Planning));
        view.action_progress = command.action_progress.clone();
        view.current_plan = Some(plan);
        view.latest_checkpoint = Some(checkpoint);
        view.updated_at = at.into();
        let mut revisions = codec::revisions(&current.manifest);
        revisions["planRevision"] = Value::from(plan_revision);
        revisions["checkpointRevision"] = Value::from(checkpoint_revision);
        revisions["checkpointResultSequence"] = Value::from(current.view.result_refs.len() as u64);
        self.view_updates(super::write::WorkViewUpdates {
            current,
            view: &view,
            identity,
            revisions: &revisions,
            children,
            create,
            leading,
        })
        .await
    }

    pub(super) async fn checkpoint_impl(
        &self,
        command: CheckpointCommand,
    ) -> Result<WorkView, BtccError> {
        let identity =
            codec::mutation_identity(&command.input.mutation_call_id, &command.request_sha256);
        let repo = self.clone();
        let prepare_identity = identity.clone();
        let outcome = self
            .publish(
                identity,
                move || async move {
                    let current = repo.require_bound(&command.input.scope, false).await?;
                    if current
                        .manifest
                        .get("currentPlanRevisionId")
                        .and_then(Value::as_str)
                        != Some(command.expected_plan_revision_id.as_str())
                        || current
                            .manifest
                            .get("checkpointRevision")
                            .and_then(Value::as_u64)
                            != Some(command.expected_progress_revision)
                    {
                        return Err(invalid("project_work_checkpoint_precondition_mismatch"));
                    }
                    let at = repo.recorded_at(prepare_identity.clone()).await?;
                    let revision = codec::number(&current.manifest, "checkpointRevision")? + 1;
                    let child = checkpoint_child(CheckpointChildInput {
                        current: &current,
                        turn_id: &command.input.scope.turn_id,
                        identity: &prepare_identity,
                        at: &at,
                        revision,
                        stage: command.stage,
                        plan_id: &command.expected_plan_revision_id,
                        progress: &command.action_progress,
                        summary: &command.public_summary,
                        next: &command.next_step,
                        checkpoint_identity: &command.input.mutation_call_id,
                    })?;
                    let checkpoint: Checkpoint = codec::typed(
                        child
                            .get("checkpoint")
                            .cloned()
                            .ok_or_else(|| invalid("project_work_managed_record_invalid"))?,
                    )?;
                    let mut view = current.view.clone();
                    view.status = status_for_progress(&command.action_progress);
                    view.current_stage = Some(command.stage);
                    view.allowed_next_stages =
                        crate::btcc::allowed_next_work_stages(Some(command.stage));
                    view.action_progress = command.action_progress.clone();
                    view.latest_checkpoint = Some(checkpoint);
                    view.updated_at = at;
                    let mut revisions = codec::revisions(&current.manifest);
                    revisions["checkpointRevision"] = Value::from(revision);
                    revisions["checkpointResultSequence"] =
                        Value::from(current.view.result_refs.len() as u64);
                    Ok(Some(
                        repo.view_updates(super::write::WorkViewUpdates {
                            current: &current,
                            view: &view,
                            identity: &prepare_identity,
                            revisions: &revisions,
                            children: vec![child],
                            create: false,
                            leading: Vec::new(),
                        })
                        .await?,
                    ))
                },
                true,
            )
            .await?;
        let work_id = published_work_id(&outcome)
            .ok_or_else(|| invalid("project_work_replay_target_missing"))?;
        Ok(self.require_current(&work_id).await?.view)
    }
}

pub(super) fn checkpoint_child(input: CheckpointChildInput<'_>) -> Result<Value, BtccError> {
    let CheckpointChildInput {
        current,
        turn_id,
        identity,
        at,
        revision,
        stage,
        plan_id,
        progress,
        summary,
        next,
        checkpoint_identity,
    } = input;
    let id = codec::record_id("checkpoint", checkpoint_identity);
    let refs = current
        .view
        .result_refs
        .iter()
        .map(|item| item.result_ref.clone())
        .collect::<Vec<_>>();
    Ok(json!({
        "schema":"butler.btcc-project-work-checkpoint.v1", "workId":current.view.work_id,
        "operationIdentity":codec::identity_value(identity), "checkpointIdentity":checkpoint_identity,
        "resultWindow":{"fromSequence":0,"toSequence":current.view.result_refs.len()},
        "checkpoint":{
            "checkpointRevisionId":id,"revision":revision,"planRevisionId":plan_id,"stage":stage,
            "actionProgress":progress,"publicSummary":summary,"nextStep":next,
            "referencedResultRefs":refs,"originTurnId":turn_id,"createdAt":at,
        },
    }))
}

pub(super) struct CheckpointChildInput<'a> {
    pub current: &'a Snapshot,
    pub turn_id: &'a str,
    pub identity: &'a ProjectWorkOperationIdentity,
    pub at: &'a str,
    pub revision: u64,
    pub stage: WorkStage,
    pub plan_id: &'a str,
    pub progress: &'a [crate::btcc::ActionProgress],
    pub summary: &'a str,
    pub next: &'a str,
    pub checkpoint_identity: &'a str,
}

pub(super) fn status_for_progress(progress: &[crate::btcc::ActionProgress]) -> WorkStatus {
    if progress
        .iter()
        .any(|item| item.status == crate::btcc::ActionStatus::Blocked)
    {
        WorkStatus::Blocked
    } else {
        WorkStatus::Open
    }
}

fn empty_revisions() -> Value {
    json!({"planRevision":0,"checkpointRevision":0,"checkpointResultSequence":0,"reviewRevision":0,"dispositionRevision":0})
}
