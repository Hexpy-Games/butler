use std::collections::HashMap;

use serde_json::{Value, json};

use butler_turn::btcc::{
    BtccError, Checkpoint, CheckpointCommand, DurableWorkStatus as WorkStatus,
    ProjectWorkOperationIdentity, ReplacePlanCommand, WorkPlan, WorkStage, WorkView,
};

use super::super::publication::ProjectLedgerRecordOperation;
use super::super::publication::ProjectLedgerRecordUpdate;
use super::codec::{self, Snapshot};
use super::publication::Projection;
use super::publication::published_work_id;
use super::relation::Bound;
use super::start::{binding_child, opening_view};
use super::{ProjectWorkRepository, invalid};

struct PlanUpdatesInput<'a> {
    current: &'a Snapshot,
    command: &'a ReplacePlanCommand,
    identity: &'a ProjectWorkOperationIdentity,
    at: &'a str,
    opening: Option<Value>,
    operation: ProjectLedgerRecordOperation,
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
        self.publish(
            identity,
            move || async move {
                repo.replace_plan_updates(&command, &prepare_identity)
                    .await
                    .map(Some)
            },
            Projection::Recover,
        )
        .await?;
        Ok(self.require_current(&target_id).await?.view)
    }

    /// The plan updates on the scope's current Work, or on a new Work opened
    /// for it (abandoning the session's previous head).
    async fn replace_plan_updates(
        &self,
        command: &ReplacePlanCommand,
        identity: &ProjectWorkOperationIdentity,
    ) -> Result<Vec<ProjectLedgerRecordUpdate>, BtccError> {
        let scope = &command.input.scope;
        let relation = self.relation(scope).await?;
        if command.start_new && relation.binding.is_some() {
            return Err(invalid("project_work_turn_already_bound"));
        }
        let current = if command.start_new {
            None
        } else {
            self.current_for_scope(scope).await?
        };
        let at = self.recorded_at(identity.clone()).await?;
        if let Some(current) = current {
            return self
                .plan_updates(PlanUpdatesInput {
                    current: &current,
                    command,
                    identity,
                    at: &at,
                    opening: None,
                    operation: ProjectLedgerRecordOperation::Update,
                    leading: Vec::new(),
                })
                .await;
        }
        let (current, opening) = self.opening_work(command, identity, &at).await?;
        let mut leading = Vec::new();
        if let Some(prior) = relation.head {
            leading.push(self.abandon_prior_head(&prior, identity, &at).await?);
        }
        self.plan_updates(PlanUpdatesInput {
            current: &current,
            command,
            identity,
            at: &at,
            opening: Some(opening),
            operation: ProjectLedgerRecordOperation::Create,
            leading,
        })
        .await
    }

    /// A not-yet-published Work for a plan that opens one: its snapshot
    /// (manifest and opening view) and its first binding child.
    async fn opening_work(
        &self,
        command: &ReplacePlanCommand,
        identity: &ProjectWorkOperationIdentity,
        at: &str,
    ) -> Result<(Snapshot, Value), BtccError> {
        let scope = &command.input.scope;
        let work_id = codec::record_id("work", &command.input.mutation_call_id);
        let original = self
            .shared
            .projection
            .load_original_request(scope.clone())
            .await?;
        if original.turn_id != scope.turn_id {
            return Err(invalid("project_work_origin_turn_mismatch"));
        }
        let (binding_id, child) =
            binding_child(&scope.turn_id, &scope.session_id, &work_id, 1, identity, at);
        let view = opening_view(
            self,
            scope,
            &command.input.objective,
            &work_id,
            &original.message_id,
            at,
        );
        let material = self
            .shared
            .projection
            .capture_work_material(butler_turn::btcc::ProjectWorkMaterialInput {
                candidate: view.clone(),
            })
            .await?;
        codec::assert_material(&view, &material)?;
        let manifest = codec::manifest_for_view(codec::ManifestViewInput {
            prior: None,
            view: &view,
            scope: &self.scope,
            identity,
            binding_refs: json!([{"bindingRevisionId":binding_id,"turnId":scope.turn_id,"revision":1}]),
            session_head: true,
            material: &material,
            revisions: &codec::Revisions::default(),
        })?;
        let snapshot = Snapshot {
            manifest,
            view,
            children: HashMap::new(),
        };
        Ok((snapshot, child))
    }

    /// The new plan child with its conception (for an opening plan) and
    /// planning checkpoints, and the manifest now in the planning stage.
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
            operation,
            leading,
        } = input;
        plan_preconditions(current, command)?;
        let plan_revision = codec::number(&current.manifest, "planRevision")? + 1;
        let plan_id = codec::record_id("plan", &command.input.mutation_call_id);
        let plan = new_plan(command, &plan_id, plan_revision, at)?;
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
        let stage_checkpoint = |revision: u64, stage: WorkStage, suffix: &str| {
            checkpoint_child(CheckpointChildInput {
                current,
                turn_id: &command.input.scope.turn_id,
                identity,
                at,
                revision,
                stage,
                plan_id: &plan_id,
                progress: &command.action_progress,
                summary,
                next,
                checkpoint_identity: &format!("{}\0{suffix}", command.input.mutation_call_id),
            })
        };
        if command.opening_plan {
            checkpoint_revision += 1;
            children.push(stage_checkpoint(
                checkpoint_revision,
                WorkStage::Conception,
                "conception",
            ));
        }
        checkpoint_revision += 1;
        let planning = stage_checkpoint(checkpoint_revision, WorkStage::Planning, "plan");
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
        let view = planned_view(current, command, plan, checkpoint, at);
        let mut revisions = codec::revisions(&current.manifest);
        revisions.plan_revision = plan_revision;
        revisions.checkpoint_revision = checkpoint_revision;
        revisions.checkpoint_result_sequence = current.view.result_refs.len() as u64;
        self.view_updates(super::write::WorkViewUpdates {
            current,
            view: &view,
            identity,
            revisions: &revisions,
            children,
            operation,
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
                    repo.checkpoint_updates(&command, &prepare_identity)
                        .await
                        .map(Some)
                },
                Projection::Recover,
            )
            .await?;
        let work_id = published_work_id(&outcome)
            .ok_or_else(|| invalid("project_work_replay_target_missing"))?;
        Ok(self.require_current(&work_id).await?.view)
    }

    /// The checkpoint child at the command's stage and the manifest it moves.
    async fn checkpoint_updates(
        &self,
        command: &CheckpointCommand,
        identity: &ProjectWorkOperationIdentity,
    ) -> Result<Vec<ProjectLedgerRecordUpdate>, BtccError> {
        let current = self
            .require_bound(&command.input.scope, Bound::Open)
            .await?;
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
        let at = self.recorded_at(identity.clone()).await?;
        let revision = codec::number(&current.manifest, "checkpointRevision")? + 1;
        let child = checkpoint_child(CheckpointChildInput {
            current: &current,
            turn_id: &command.input.scope.turn_id,
            identity,
            at: &at,
            revision,
            stage: command.stage,
            plan_id: &command.expected_plan_revision_id,
            progress: &command.action_progress,
            summary: &command.public_summary,
            next: &command.next_step,
            checkpoint_identity: &command.input.mutation_call_id,
        });
        let checkpoint: Checkpoint = codec::typed(
            child
                .get("checkpoint")
                .cloned()
                .ok_or_else(|| invalid("project_work_managed_record_invalid"))?,
        )?;
        let mut view = current.view.clone();
        view.status = status_for_progress(&command.action_progress);
        view.current_stage = Some(command.stage);
        view.allowed_next_stages = butler_turn::btcc::allowed_next_work_stages(Some(command.stage));
        view.action_progress = command.action_progress.clone();
        view.latest_checkpoint = Some(checkpoint);
        view.updated_at = at;
        let mut revisions = codec::revisions(&current.manifest);
        revisions.checkpoint_revision = revision;
        revisions.checkpoint_result_sequence = current.view.result_refs.len() as u64;
        self.view_updates(super::write::WorkViewUpdates {
            current: &current,
            view: &view,
            identity,
            revisions: &revisions,
            children: vec![child],
            operation: ProjectLedgerRecordOperation::Update,
            leading: Vec::new(),
        })
        .await
    }
}

/// The plan revision the command replaces the current plan with.
fn new_plan(
    command: &ReplacePlanCommand,
    plan_id: &str,
    revision: u64,
    at: &str,
) -> Result<WorkPlan, BtccError> {
    codec::typed(json!({
        "planRevisionId":plan_id, "revision":revision,
        "objective":command.input.objective, "governingRefs":command.governing_refs,
        "executionMode":command.input.execution_mode, "actions":command.input.actions,
        "checks":command.input.checks, "originTurnId":command.input.scope.turn_id, "createdAt":at,
    }))
}

/// The plan targets the expected Work at the expected progress revision.
fn plan_preconditions(current: &Snapshot, command: &ReplacePlanCommand) -> Result<(), BtccError> {
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
    Ok(())
}

/// The Work in the planning stage under its new plan.
fn planned_view(
    current: &Snapshot,
    command: &ReplacePlanCommand,
    plan: WorkPlan,
    checkpoint: Checkpoint,
    at: &str,
) -> WorkView {
    let mut view = current.view.clone();
    view.objective = command.input.objective.clone();
    view.status = status_for_progress(&command.action_progress);
    view.current_stage = Some(WorkStage::Planning);
    view.allowed_next_stages =
        butler_turn::btcc::allowed_next_work_stages(Some(WorkStage::Planning));
    view.action_progress = command.action_progress.clone();
    view.current_plan = Some(plan);
    view.latest_checkpoint = Some(checkpoint);
    view.updated_at = at.into();
    view
}

pub(super) fn checkpoint_child(input: CheckpointChildInput<'_>) -> Value {
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
    json!({
        "schema":"butler.btcc-project-work-checkpoint.v1", "workId":current.view.work_id,
        "operationIdentity":codec::identity_value(identity), "checkpointIdentity":checkpoint_identity,
        "resultWindow":{"fromSequence":0,"toSequence":current.view.result_refs.len()},
        "checkpoint":{
            "checkpointRevisionId":id,"revision":revision,"planRevisionId":plan_id,"stage":stage,
            "actionProgress":progress,"publicSummary":summary,"nextStep":next,
            "referencedResultRefs":refs,"originTurnId":turn_id,"createdAt":at,
        },
    })
}

#[derive(Clone, Copy)]
pub(super) struct CheckpointChildInput<'a> {
    pub current: &'a Snapshot,
    pub turn_id: &'a str,
    pub identity: &'a ProjectWorkOperationIdentity,
    pub at: &'a str,
    pub revision: u64,
    pub stage: WorkStage,
    pub plan_id: &'a str,
    pub progress: &'a [butler_turn::btcc::ActionProgress],
    pub summary: &'a str,
    pub next: &'a str,
    pub checkpoint_identity: &'a str,
}

pub(super) fn status_for_progress(progress: &[butler_turn::btcc::ActionProgress]) -> WorkStatus {
    if progress
        .iter()
        .any(|item| item.status == butler_turn::btcc::ActionStatus::Blocked)
    {
        WorkStatus::Blocked
    } else {
        WorkStatus::Open
    }
}
