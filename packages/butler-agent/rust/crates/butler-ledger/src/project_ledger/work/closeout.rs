use serde_json::{Value, json};

use butler_turn::btcc::{
    ActionProgress, BtccError, Checkpoint, ClaimCloseoutCorrectionInput, DispositionCommand,
    DispositionStatus, DurableWorkStatus as WorkStatus, ProjectWorkDispositionPreparation,
    ProjectWorkOperationIdentity, ProjectWorkOperationKind, ReviewCommand, ReviewSubject,
    WorkDisposition, WorkReview, WorkStage, WorkView,
};

use super::super::publication::{ProjectLedgerRecordKind, ProjectLedgerRecordUpdate};
use super::codec::{self, Snapshot};
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
                    repo.review_updates(&command, &prepare_identity)
                        .await
                        .map(Some)
                },
                true,
            )
            .await?;
        let id = published_work_id(&outcome)
            .ok_or_else(|| invalid("project_work_replay_target_missing"))?;
        Ok(self.require_current(&id).await?.view)
    }

    /// The review child, bracketed by entry and exit checkpoints when the
    /// review moves the Work between stages, and the reviewed manifest.
    async fn review_updates(
        &self,
        command: &ReviewCommand,
        identity: &ProjectWorkOperationIdentity,
    ) -> Result<Vec<ProjectLedgerRecordUpdate>, BtccError> {
        let current = self.require_bound(&command.input.scope, false).await?;
        review_preconditions(&current, command)?;
        let at = self.recorded_at(identity.clone()).await?;
        let mut trail = Trail::new(&current, identity, &at)?;
        if command.input.subject == ReviewSubject::Completion
            || command.current_stage != command.entry_stage
            || command.progress_changed
        {
            trail.review_checkpoint(command, command.entry_stage, "entry")?;
        }
        let review_revision = codec::number(&current.manifest, "reviewRevision")? + 1;
        let review = review_for(command, &current.view, review_revision, &at)?;
        trail.children.push(json!({
            "schema":"butler.btcc-project-work-review.v1", "workId":current.view.work_id,
            "operationIdentity":codec::identity_value(identity),
            "boundResultSequence":current.view.result_refs.len(), "review":review,
        }));
        if command.next_stage != command.entry_stage {
            trail.review_checkpoint(command, command.next_stage, "exit")?;
        }
        let mut view = current.view.clone();
        view.status = status_for_progress(&command.action_progress);
        view.current_stage = Some(command.next_stage);
        view.allowed_next_stages =
            butler_turn::btcc::allowed_next_work_stages(Some(command.next_stage));
        view.action_progress = command.action_progress.clone();
        if let Some(checkpoint) = trail.latest.as_ref() {
            view.latest_checkpoint = Some(checkpoint.clone());
        }
        match command.input.subject {
            ReviewSubject::Plan => view.latest_plan_review = Some(review),
            ReviewSubject::Result => view.latest_result_review = Some(review),
            ReviewSubject::Completion => view.latest_completion_validation = Some(review),
        }
        view.updated_at = at.clone();
        let mut revisions = trail.revisions();
        revisions["reviewRevision"] = Value::from(review_revision);
        self.view_updates(super::write::WorkViewUpdates {
            current: &current,
            view: &view,
            identity,
            revisions: &revisions,
            children: trail.children,
            create: false,
            leading: Vec::new(),
        })
        .await
    }

    pub(super) async fn disposition_impl(
        &self,
        command: DispositionCommand,
    ) -> Result<WorkView, BtccError> {
        self.assert_scope(&command.input.scope)?;
        let identity =
            codec::mutation_identity(&command.input.mutation_call_id, &command.request_sha256);
        let repo = self.clone();
        let work_id = command.input.work_id.clone();
        let prepare_identity = identity.clone();
        self.publish(
            identity,
            move || async move { repo.disposition_updates(&command, &prepare_identity).await },
            true,
        )
        .await?;
        Ok(self.require_current(&work_id).await?.view)
    }

    /// The disposition child (with its material snapshot), a closing
    /// checkpoint when a plan exists, and the disposed manifest; nothing when
    /// the runtime keeps the current view.
    async fn disposition_updates(
        &self,
        command: &DispositionCommand,
        identity: &ProjectWorkOperationIdentity,
    ) -> Result<Option<Vec<ProjectLedgerRecordUpdate>>, BtccError> {
        let runtime_owned_open = command.input.disposition == DispositionStatus::Open
            && command
                .input
                .runtime_owned_open_generation
                .is_some_and(|value| value.version == 1);
        let current = self
            .require_bound(&command.input.scope, runtime_owned_open)
            .await?;
        disposition_preconditions(&current, command)?;
        let decision = self
            .shared
            .projection
            .prepare_disposition(command.clone(), current.view.clone())
            .await?;
        let ProjectWorkDispositionPreparation::Apply {
            action_progress,
            evidence_snapshot,
        } = decision
        else {
            return Ok(None);
        };
        let at = self.recorded_at(identity.clone()).await?;
        let revision = codec::number(&current.manifest, "dispositionRevision")? + 1;
        let mut trail = Trail::new(&current, identity, &at)?;
        trail.latest = current.view.latest_checkpoint.clone();
        if let Some(plan) = &current.view.current_plan {
            trail.disposition_checkpoint(command, &plan.plan_revision_id, &action_progress)?;
        }
        let mut provisional = current.view.clone();
        provisional.status = disposed_status(command.input.disposition);
        provisional.action_progress = action_progress;
        provisional.latest_checkpoint = trail.latest.clone();
        provisional.updated_at = at.clone();
        let material = self
            .shared
            .projection
            .capture_work_material(butler_turn::btcc::ProjectWorkMaterialInput {
                candidate: provisional.clone(),
            })
            .await?;
        codec::assert_material(&provisional, &material)?;
        let disposition = disposition_for(DispositionRecord {
            command,
            current: &current,
            revision,
            fingerprint: &material.material_fingerprint,
            runtime_owned_open,
            evidence_snapshot,
            at: &at,
        })?;
        trail.children.insert(
            0,
            json!({
                "schema":"butler.btcc-project-work-disposition.v1", "workId":current.view.work_id,
                "operationIdentity":codec::identity_value(identity),
                "disposition":disposition, "materialSnapshot":material.material_snapshot,
            }),
        );
        provisional.latest_disposition = Some(disposition);
        let mut revisions = trail.revisions();
        revisions["dispositionRevision"] = Value::from(revision);
        self.disposed_updates(
            &current,
            identity,
            &provisional,
            &material,
            &revisions,
            trail.children,
        )
        .await
        .map(Some)
    }

    /// The disposed manifest's Work record update, then one update per child.
    async fn disposed_updates(
        &self,
        current: &Snapshot,
        identity: &ProjectWorkOperationIdentity,
        view: &WorkView,
        material: &butler_turn::btcc::ProjectWorkCapturedMaterial,
        revisions: &Value,
        children: Vec<Value>,
    ) -> Result<Vec<ProjectLedgerRecordUpdate>, BtccError> {
        let manifest = codec::manifest_for_view(codec::ManifestViewInput {
            prior: Some(&current.manifest),
            view,
            scope: &self.scope,
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
            material,
            revisions,
        })?;
        let mut updates = vec![codec::work_update(
            &manifest,
            false,
            &self.shared.ledger.collation,
        )?];
        for child in children {
            let (id, kind, title) = super::write::child_metadata(&child)?;
            if let Some(update) = self
                .child_update(&current.view.work_id, &id, kind, title, child)
                .await?
            {
                updates.push(update);
            }
        }
        Ok(updates)
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

fn disposed_status(disposition: DispositionStatus) -> WorkStatus {
    match disposition {
        DispositionStatus::Completed => WorkStatus::Completed,
        DispositionStatus::Open => WorkStatus::Open,
        DispositionStatus::Blocked => WorkStatus::Blocked,
    }
}

fn review_preconditions(current: &Snapshot, command: &ReviewCommand) -> Result<(), BtccError> {
    let manifest = &current.manifest;
    if manifest
        .get("currentPlanRevisionId")
        .and_then(Value::as_str)
        != Some(command.expected_plan_revision_id.as_str())
        || manifest.get("checkpointRevision").and_then(Value::as_u64)
            != Some(command.expected_progress_revision)
        || manifest.get("resultSequence").and_then(Value::as_u64)
            != Some(command.expected_result_sequence)
    {
        return Err(invalid("project_work_review_precondition_mismatch"));
    }
    Ok(())
}

fn disposition_preconditions(
    current: &Snapshot,
    command: &DispositionCommand,
) -> Result<(), BtccError> {
    if current.view.work_id != command.input.work_id {
        return Err(invalid("project_work_disposition_target_mismatch"));
    }
    if command
        .input
        .expected_material_fingerprint
        .as_ref()
        .is_some_and(|expected| {
            current
                .manifest
                .get("materialFingerprint")
                .and_then(Value::as_str)
                != Some(expected.as_str())
        })
    {
        return Err(invalid("project_work_material_fingerprint_mismatch"));
    }
    Ok(())
}

/// The checkpoints one operation adds before publishing, numbered after the
/// manifest's current checkpoint revision.
struct Trail<'a> {
    current: &'a Snapshot,
    identity: &'a ProjectWorkOperationIdentity,
    at: &'a str,
    revision: u64,
    children: Vec<Value>,
    latest: Option<Checkpoint>,
}

impl<'a> Trail<'a> {
    fn new(
        current: &'a Snapshot,
        identity: &'a ProjectWorkOperationIdentity,
        at: &'a str,
    ) -> Result<Self, BtccError> {
        Ok(Self {
            current,
            identity,
            at,
            revision: codec::number(&current.manifest, "checkpointRevision")?,
            children: Vec::new(),
            latest: None,
        })
    }

    fn push(&mut self, input: CheckpointChildInput<'_>) -> Result<(), BtccError> {
        let child = checkpoint_child(input)?;
        self.latest =
            Some(codec::typed(child.get("checkpoint").cloned().ok_or_else(
                || invalid("project_work_managed_record_invalid"),
            )?)?);
        self.children.push(child);
        Ok(())
    }

    /// A checkpoint at `stage` entering or leaving the reviewed stage.
    fn review_checkpoint(
        &mut self,
        command: &ReviewCommand,
        stage: WorkStage,
        edge: &str,
    ) -> Result<(), BtccError> {
        self.revision += 1;
        let next = command
            .input
            .corrections
            .first()
            .map(String::as_str)
            .unwrap_or("");
        let checkpoint_identity = format!(
            "{}\0{}-{edge}",
            command.input.mutation_call_id,
            stage_name(command.entry_stage)
        );
        self.push(CheckpointChildInput {
            current: self.current,
            turn_id: &command.input.scope.turn_id,
            identity: self.identity,
            at: self.at,
            revision: self.revision,
            stage,
            plan_id: &command.expected_plan_revision_id,
            progress: &command.action_progress,
            summary: &command.input.summary,
            next,
            checkpoint_identity: &checkpoint_identity,
        })
    }

    /// The checkpoint closing the current plan with the disposed progress.
    fn disposition_checkpoint(
        &mut self,
        command: &DispositionCommand,
        plan_id: &str,
        progress: &[ActionProgress],
    ) -> Result<(), BtccError> {
        self.revision += 1;
        let next = command
            .remaining_actions
            .first()
            .map(String::as_str)
            .or(command.input.next_condition.as_deref())
            .unwrap_or("");
        let checkpoint_identity = format!("{}\0disposition", command.input.mutation_call_id);
        self.push(CheckpointChildInput {
            current: self.current,
            turn_id: &command.input.scope.turn_id,
            identity: self.identity,
            at: self.at,
            revision: self.revision,
            stage: self
                .current
                .view
                .current_stage
                .unwrap_or(WorkStage::Planning),
            plan_id,
            progress,
            summary: &command.normalized_summary,
            next,
            checkpoint_identity: &checkpoint_identity,
        })
    }

    /// The manifest revisions after these checkpoints.
    fn revisions(&self) -> Value {
        let mut revisions = codec::revisions(&self.current.manifest);
        revisions["checkpointRevision"] = Value::from(self.revision);
        if self.latest.is_some() {
            revisions["checkpointResultSequence"] =
                Value::from(self.current.view.result_refs.len() as u64);
        }
        revisions
    }
}

struct DispositionRecord<'a> {
    command: &'a DispositionCommand,
    current: &'a Snapshot,
    revision: u64,
    fingerprint: &'a str,
    runtime_owned_open: bool,
    evidence_snapshot: Vec<String>,
    at: &'a str,
}

fn disposition_for(input: DispositionRecord<'_>) -> Result<WorkDisposition, BtccError> {
    let DispositionRecord {
        command,
        current,
        revision,
        fingerprint,
        runtime_owned_open,
        evidence_snapshot,
        at,
    } = input;
    codec::typed(json!({
        "dispositionRevisionId":codec::record_id("disposition", &command.input.mutation_call_id),
        "revision":revision, "resultSequence":current.view.result_refs.len(),
        "materialFingerprint":fingerprint,
        "runtimeOwnedOpen":runtime_owned_open, "disposition":command.input.disposition,
        "summary":command.normalized_summary, "actionUpdates":command.action_updates,
        "remainingActions":command.remaining_actions,
        "nextCondition":command.input.next_condition,
        "evidenceRefs":command.evidence_refs,
        "evidenceSnapshot":evidence_snapshot, "followups":command.followups,
        "originTurnId":command.input.scope.turn_id, "createdAt":at,
    }))
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

fn stage_name(stage: butler_turn::btcc::WorkStage) -> &'static str {
    match stage {
        butler_turn::btcc::WorkStage::Conception => "conception",
        butler_turn::btcc::WorkStage::Planning => "planning",
        butler_turn::btcc::WorkStage::Execution => "execution",
        butler_turn::btcc::WorkStage::Review => "review",
        butler_turn::btcc::WorkStage::Validation => "validation",
        butler_turn::btcc::WorkStage::Reporting => "reporting",
    }
}
