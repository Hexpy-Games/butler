use serde_json::{Value, json};

use crate::btcc::{
    BtccError, ClaimCloseoutCorrectionInput, DispositionCommand, DispositionStatus,
    DurableWorkStatus as WorkStatus, ProjectWorkDispositionPreparation,
    ProjectWorkOperationIdentity, ProjectWorkOperationKind, ReviewCommand, ReviewSubject,
    WorkDisposition, WorkReview, WorkView,
};

use super::super::publication::ProjectLedgerRecordKind;
use super::codec;
use super::progress::{CheckpointChildInput, checkpoint_child, status_for_progress};
use super::publication::published_work_id;
use super::{ProjectWorkRepository, invalid};

impl ProjectWorkRepository {
    pub(super) async fn review_impl(&self, command: ReviewCommand) -> Result<WorkView, BtccError> {
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
                        || current
                            .manifest
                            .get("resultSequence")
                            .and_then(Value::as_u64)
                            != Some(command.expected_result_sequence)
                    {
                        return Err(invalid("project_work_review_precondition_mismatch"));
                    }
                    let at = repo.recorded_at(prepare_identity.clone()).await?;
                    let mut checkpoint_revision =
                        codec::number(&current.manifest, "checkpointRevision")?;
                    let mut children = Vec::new();
                    let mut latest_checkpoint: Option<crate::btcc::Checkpoint> = None;
                    let next = command
                        .input
                        .corrections
                        .first()
                        .map(String::as_str)
                        .unwrap_or("");
                    if command.input.subject == ReviewSubject::Completion
                        || command.current_stage != command.entry_stage
                        || command.progress_changed
                    {
                        checkpoint_revision += 1;
                        let child = checkpoint_child(CheckpointChildInput {
                            current: &current,
                            turn_id: &command.input.scope.turn_id,
                            identity: &prepare_identity,
                            at: &at,
                            revision: checkpoint_revision,
                            stage: command.entry_stage,
                            plan_id: &command.expected_plan_revision_id,
                            progress: &command.action_progress,
                            summary: &command.input.summary,
                            next,
                            checkpoint_identity: &format!(
                                "{}\0{}-entry",
                                command.input.mutation_call_id,
                                stage_name(command.entry_stage)
                            ),
                        })?;
                        latest_checkpoint =
                            Some(codec::typed(child.get("checkpoint").cloned().ok_or_else(
                                || invalid("project_work_managed_record_invalid"),
                            )?)?);
                        children.push(child);
                    }
                    let review_revision = codec::number(&current.manifest, "reviewRevision")? + 1;
                    let review = review_for(&command, &current.view, review_revision, &at)?;
                    children.push(json!({
                "schema":"butler.btcc-project-work-review.v1", "workId":current.view.work_id,
                "operationIdentity":codec::identity_value(&prepare_identity),
                "boundResultSequence":current.view.result_refs.len(), "review":review,
            }));
                    if command.next_stage != command.entry_stage {
                        checkpoint_revision += 1;
                        let child = checkpoint_child(CheckpointChildInput {
                            current: &current,
                            turn_id: &command.input.scope.turn_id,
                            identity: &prepare_identity,
                            at: &at,
                            revision: checkpoint_revision,
                            stage: command.next_stage,
                            plan_id: &command.expected_plan_revision_id,
                            progress: &command.action_progress,
                            summary: &command.input.summary,
                            next,
                            checkpoint_identity: &format!(
                                "{}\0{}-exit",
                                command.input.mutation_call_id,
                                stage_name(command.entry_stage)
                            ),
                        })?;
                        latest_checkpoint =
                            Some(codec::typed(child.get("checkpoint").cloned().ok_or_else(
                                || invalid("project_work_managed_record_invalid"),
                            )?)?);
                        children.push(child);
                    }
                    let mut view = current.view.clone();
                    view.status = status_for_progress(&command.action_progress);
                    view.current_stage = Some(command.next_stage);
                    view.allowed_next_stages =
                        crate::btcc::allowed_next_work_stages(Some(command.next_stage));
                    view.action_progress = command.action_progress.clone();
                    if let Some(checkpoint) = latest_checkpoint.as_ref() {
                        view.latest_checkpoint = Some(checkpoint.clone());
                    }
                    match command.input.subject {
                        ReviewSubject::Plan => view.latest_plan_review = Some(review),
                        ReviewSubject::Result => view.latest_result_review = Some(review),
                        ReviewSubject::Completion => {
                            view.latest_completion_validation = Some(review)
                        }
                    }
                    view.updated_at = at;
                    let mut revisions = codec::revisions(&current.manifest);
                    revisions["reviewRevision"] = Value::from(review_revision);
                    revisions["checkpointRevision"] = Value::from(checkpoint_revision);
                    if latest_checkpoint.is_some() {
                        revisions["checkpointResultSequence"] =
                            Value::from(current.view.result_refs.len() as u64);
                    }
                    Ok(Some(
                        repo.view_updates(super::write::WorkViewUpdates {
                            current: &current,
                            view: &view,
                            identity: &prepare_identity,
                            revisions: &revisions,
                            children,
                            create: false,
                            leading: Vec::new(),
                        })
                        .await?,
                    ))
                },
                true,
            )
            .await?;
        let id = published_work_id(&outcome)
            .ok_or_else(|| invalid("project_work_replay_target_missing"))?;
        Ok(self.require_current(&id).await?.view)
    }

    pub(super) async fn disposition_impl(
        &self,
        command: DispositionCommand,
    ) -> Result<WorkView, BtccError> {
        self.assert_scope(&command.input.scope)?;
        let identity =
            codec::mutation_identity(&command.input.mutation_call_id, &command.request_sha256);
        let allow_completed = command.input.disposition == DispositionStatus::Open
            && command
                .input
                .runtime_owned_open_generation
                .is_some_and(|value| value.version == 1);
        let repo = self.clone();
        let work_id = command.input.work_id.clone();
        let prepare_identity = identity.clone();
        self.publish(identity, move || async move {
            let current = repo.require_bound(&command.input.scope, allow_completed).await?;
            if current.view.work_id != command.input.work_id { return Err(invalid("project_work_disposition_target_mismatch")); }
            if command.input.expected_material_fingerprint.as_ref().is_some_and(|expected|
                current.manifest.get("materialFingerprint").and_then(Value::as_str) != Some(expected.as_str())) {
                return Err(invalid("project_work_material_fingerprint_mismatch"));
            }
            let decision = repo.shared.projection.prepare_disposition(command.clone(), current.view.clone()).await?;
            let ProjectWorkDispositionPreparation::Apply { action_progress, evidence_snapshot } = decision else { return Ok(None) };
            let at = repo.recorded_at(prepare_identity.clone()).await?;
            let revision = codec::number(&current.manifest, "dispositionRevision")? + 1;
            let mut children = Vec::new();
            let mut checkpoint_revision = codec::number(&current.manifest, "checkpointRevision")?;
            let mut latest_checkpoint = current.view.latest_checkpoint.clone();
            if let Some(plan) = &current.view.current_plan {
                checkpoint_revision += 1;
                let next = command.remaining_actions.first().map(String::as_str)
                    .or(command.input.next_condition.as_deref()).unwrap_or("");
                let child = checkpoint_child(CheckpointChildInput {
                    current: &current,
                    turn_id: &command.input.scope.turn_id,
                    identity: &prepare_identity,
                    at: &at,
                    revision: checkpoint_revision,
                    stage: current.view.current_stage.unwrap_or(crate::btcc::WorkStage::Planning),
                    plan_id: &plan.plan_revision_id,
                    progress: &action_progress,
                    summary: &command.normalized_summary,
                    next,
                    checkpoint_identity: &format!("{}\0disposition", command.input.mutation_call_id),
                })?;
                latest_checkpoint = Some(codec::typed(child.get("checkpoint").cloned().ok_or_else(|| invalid("project_work_managed_record_invalid"))?)?);
                children.push(child);
            }
            let mut provisional = current.view.clone();
            provisional.status = match command.input.disposition {
                DispositionStatus::Completed => WorkStatus::Completed,
                DispositionStatus::Open => WorkStatus::Open,
                DispositionStatus::Blocked => WorkStatus::Blocked,
            };
            provisional.action_progress = action_progress;
            provisional.latest_checkpoint = latest_checkpoint.clone();
            provisional.updated_at = at.clone();
            let material = repo.shared.projection.capture_work_material(crate::btcc::ProjectWorkMaterialInput {
                candidate: provisional.clone(),
            }).await?;
            codec::assert_material(&provisional, &material)?;
            let disposition: WorkDisposition = codec::typed(json!({
                "dispositionRevisionId":codec::record_id("disposition", &command.input.mutation_call_id),
                "revision":revision, "resultSequence":current.view.result_refs.len(),
                "materialFingerprint":material.material_fingerprint,
                "runtimeOwnedOpen":allow_completed, "disposition":command.input.disposition,
                "summary":command.normalized_summary, "actionUpdates":command.action_updates,
                "remainingActions":command.remaining_actions,
                "nextCondition":command.input.next_condition,
                "evidenceRefs":command.evidence_refs,
                "evidenceSnapshot":evidence_snapshot, "followups":command.followups,
                "originTurnId":command.input.scope.turn_id, "createdAt":at,
            }))?;
            children.insert(0, json!({
                "schema":"butler.btcc-project-work-disposition.v1", "workId":current.view.work_id,
                "operationIdentity":codec::identity_value(&prepare_identity),
                "disposition":disposition, "materialSnapshot":material.material_snapshot,
            }));
            provisional.latest_disposition = Some(disposition);
            let mut revisions = codec::revisions(&current.manifest);
            revisions["dispositionRevision"] = Value::from(revision);
            revisions["checkpointRevision"] = Value::from(checkpoint_revision);
            if latest_checkpoint.is_some() { revisions["checkpointResultSequence"] = Value::from(current.view.result_refs.len() as u64); }
            let manifest = codec::manifest_for_view(codec::ManifestViewInput {
                prior: Some(&current.manifest),
                view: &provisional,
                scope: &repo.scope,
                identity: &prepare_identity,
                binding_refs: current.manifest.get("bindingRefs").cloned()
                    .ok_or_else(|| invalid("project_work_managed_record_invalid"))?,
                session_head: current.manifest.get("sessionHead").and_then(Value::as_bool).unwrap_or(true),
                material: &material,
                revisions: &revisions,
            })?;
            let mut updates = vec![codec::work_update(&manifest, false, &repo.shared.ledger.collation)?];
            for child in children {
                let (id, kind, title) = super::write::child_metadata(&child)?;
                if let Some(update) = repo.child_update(&current.view.work_id, &id, kind, title, child).await? { updates.push(update); }
            }
            Ok(Some(updates))
        }, true).await?;
        Ok(self.require_current(&work_id).await?.view)
    }

    pub(super) async fn claim_closeout_impl(
        &self,
        input: ClaimCloseoutCorrectionInput,
    ) -> Result<bool, BtccError> {
        let source = format!(
            "btcc-guided-work-closeout-missing.v1\0{}\0{}",
            input.scope.turn_id, input.work_id
        );
        let digest = codec::request_digest(&Value::String(source), &self.shared.ledger.collation)?;
        let diagnostic_id = codec::record_id("diagnostic", &digest);
        let identity = ProjectWorkOperationIdentity {
            kind: ProjectWorkOperationKind::CloseoutDiagnostic,
            id: diagnostic_id.clone(),
            request_sha256: codec::request_digest(
                &json!({"turnId":input.scope.turn_id,"workId":input.work_id}),
                &self.shared.ledger.collation,
            )?,
            mutation_call_id: None,
        };
        let repo = self.clone();
        let prepare_identity = identity.clone();
        let outcome = self.publish(identity, move || async move {
            let current = repo.require_bound(&input.scope, true).await?;
            if current.view.work_id != input.work_id { return Err(invalid("project_work_closeout_target_mismatch")); }
            let child = json!({
                "schema":"butler.btcc-project-work-closeout-diagnostic.v1","workId":input.work_id,
                "operationIdentity":codec::identity_value(&prepare_identity),
                "diagnostic":{"diagnosticId":diagnostic_id,"code":"closeout_missing","turnId":input.scope.turn_id,
                    "createdAt":repo.recorded_at(prepare_identity.clone()).await?},
            });
            let Some(update) = repo.child_update(&input.work_id, &diagnostic_id, ProjectLedgerRecordKind::Reference,
                "Guided Work closeout diagnostic".into(), child).await? else {
                return Err(invalid("project_work_occurrence_receipt_missing"));
            };
            Ok(Some(vec![update]))
        }, true).await?;
        Ok(!outcome.replayed)
    }
}

fn review_for(
    command: &ReviewCommand,
    view: &WorkView,
    revision: u64,
    at: &str,
) -> Result<WorkReview, BtccError> {
    codec::typed(json!({
        "reviewRevisionId":codec::record_id("review", &command.input.mutation_call_id),
        "revision":revision,"subject":command.input.subject,"verdict":command.input.verdict,
        "summary":command.input.summary,"corrections":command.input.corrections,
        "boundPlanRevisionId":(command.input.subject != ReviewSubject::Result).then(|| command.expected_plan_revision_id.clone()),
        "boundResultReviewRevisionId":(command.input.subject == ReviewSubject::Completion)
            .then(|| command.expected_result_review_revision_id.clone()).flatten(),
        "boundActionProgress":(command.input.subject != ReviewSubject::Plan).then(|| command.action_progress.clone()),
        "boundResultRefs":if command.input.subject == ReviewSubject::Plan { Vec::new() } else { view.result_refs.iter().map(|item| item.result_ref.clone()).collect() },
        "originTurnId":command.input.scope.turn_id,"createdAt":at,
    }))
}

fn stage_name(stage: crate::btcc::WorkStage) -> &'static str {
    match stage {
        crate::btcc::WorkStage::Conception => "conception",
        crate::btcc::WorkStage::Planning => "planning",
        crate::btcc::WorkStage::Execution => "execution",
        crate::btcc::WorkStage::Review => "review",
        crate::btcc::WorkStage::Validation => "validation",
        crate::btcc::WorkStage::Reporting => "reporting",
    }
}
