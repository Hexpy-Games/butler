use serde_json::{Value, json};

use butler_turn::btcc::{
    BtccError, ClaimCloseoutCorrectionInput, DispositionCommand, DispositionStatus,
    DurableWorkStatus as WorkStatus, ProjectWorkDispositionPreparation,
    ProjectWorkOperationIdentity, ProjectWorkOperationKind, ReviewCommand, ReviewSubject,
    WorkDisposition, WorkReview, WorkView,
};

use super::super::publication::{ProjectLedgerRecordKind, ProjectLedgerRecordUpdate};
use super::codec::{self, Snapshot};
mod trail;

use super::super::publication::ProjectLedgerRecordOperation;
use super::progress::status_for_progress;
use super::publication::Projection;
use super::publication::published_work_id;
use super::relation::Bound;
use super::{ProjectWorkRepository, invalid};
use trail::Trail;

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
                Projection::Recover,
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
        let current = self
            .require_bound(&command.input.scope, Bound::Open)
            .await?;
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
        revisions.review_revision = review_revision;
        self.view_updates(super::write::WorkViewUpdates {
            current: &current,
            view: &view,
            identity,
            revisions: &revisions,
            children: trail.children,
            operation: ProjectLedgerRecordOperation::Update,
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
            Projection::Recover,
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
        let bound = if runtime_owned_open {
            Bound::OpenOrCompleted
        } else {
            Bound::Open
        };
        let current = self.require_bound(&command.input.scope, bound).await?;
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
        revisions.disposition_revision = revision;
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
        revisions: &codec::Revisions,
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
            ProjectLedgerRecordOperation::Update,
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
            let current = repo.require_bound(&input.scope, Bound::OpenOrCompleted).await?;
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
        }, Projection::Recover).await?;
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
