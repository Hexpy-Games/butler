use serde_json::Value;

use crate::btcc::BtccError;

use super::{DurableWorkService, fingerprint, serialized, with_null_project};
use crate::btcc::BtccCode;
use crate::btcc::work::contracts::*;

impl DurableWorkService {
    pub(crate) async fn record_checkpoint(
        &self,
        input: CheckpointInput,
    ) -> Result<WorkView, BtccError> {
        super::super::validation::validate_checkpoint(&input)?;
        let context = self
            .repository
            .load_context(input.scope.clone())
            .await?
            .ok_or_else(|| {
                BtccError::detected(
                    BtccCode::DurableWorkOpenMissing,
                    "Durable Work progress requires open Work",
                )
            })?;
        let plan = context.work.current_plan.as_ref().ok_or_else(|| {
            BtccError::detected(
                BtccCode::DurableWorkPlanMissing,
                "Durable Work progress requires a current Plan and stage",
            )
        })?;
        let stage = context.work.current_stage.ok_or_else(|| {
            BtccError::detected(
                BtccCode::DurableWorkStageMissing,
                "Durable Work progress requires a current Plan and stage",
            )
        })?;
        let mut identity = serde_json::Map::new();
        with_null_project(&input.scope, &mut identity);
        identity.insert(
            "mutationCallId".into(),
            Value::String(input.mutation_call_id.clone()),
        );
        identity.insert(
            "actionUpdates".into(),
            serialized(&input.action_updates.as_deref().unwrap_or(&[]))?,
        );
        identity.insert(
            "publicSummary".into(),
            input
                .public_summary
                .as_ref()
                .map_or(Value::Null, |value| Value::String(value.clone())),
        );
        identity.insert(
            "nextStep".into(),
            input
                .next_step
                .as_ref()
                .map_or(Value::Null, |value| Value::String(value.clone())),
        );
        let request_sha256 = fingerprint("record_checkpoint", &Value::Object(identity))?;
        let action_progress = super::super::policy::apply_work_action_updates(
            &context.work,
            input.action_updates.as_deref().unwrap_or(&[]),
        )?;
        let command = CheckpointCommand {
            expected_plan_revision_id: plan.plan_revision_id.clone(),
            expected_progress_revision: context
                .work
                .latest_checkpoint
                .as_ref()
                .map_or(0, |checkpoint| checkpoint.revision),
            stage,
            action_progress,
            public_summary: input
                .public_summary
                .as_deref()
                .map(str::trim)
                .unwrap_or("")
                .into(),
            next_step: input
                .next_step
                .as_deref()
                .map(str::trim)
                .unwrap_or("")
                .into(),
            input,
            request_sha256,
        };
        self.repository.record_checkpoint(command).await
    }

    pub(crate) async fn record_review(&self, input: ReviewInput) -> Result<WorkView, BtccError> {
        super::super::validation::validate_review(&input)?;
        let context = self
            .repository
            .load_context(input.scope.clone())
            .await?
            .ok_or_else(|| {
                BtccError::detected(
                    BtccCode::DurableWorkOpenMissing,
                    "Durable Work progress requires open Work",
                )
            })?;
        let plan = context.work.current_plan.as_ref().ok_or_else(|| {
            BtccError::detected(
                BtccCode::DurableWorkPlanMissing,
                "Durable Work Review requires a current Plan and stage",
            )
        })?;
        let current_stage = context.work.current_stage.ok_or_else(|| {
            BtccError::detected(
                BtccCode::DurableWorkStageMissing,
                "Durable Work Review requires a current Plan and stage",
            )
        })?;
        let (entry_stage, next_stage) = super::super::policy::resolve_work_review_transition(
            current_stage,
            input.subject,
            input.verdict,
            input.correction_scope,
        )?;
        let action_progress = super::super::policy::apply_work_action_updates(
            &context.work,
            input.action_updates.as_deref().unwrap_or(&[]),
        )?;
        let accepted_review = super::super::policy::accepted_current_result_review(&context.work);
        let mut identity = serde_json::Map::new();
        with_null_project(&input.scope, &mut identity);
        identity.insert(
            "mutationCallId".into(),
            Value::String(input.mutation_call_id.clone()),
        );
        identity.insert("subject".into(), serialized(&input.subject)?);
        identity.insert("verdict".into(), serialized(&input.verdict)?);
        identity.insert("summary".into(), Value::String(input.summary.clone()));
        identity.insert("corrections".into(), serialized(&input.corrections)?);
        identity.insert(
            "actionUpdates".into(),
            serialized(&input.action_updates.as_deref().unwrap_or(&[]))?,
        );
        identity.insert(
            "correctionScope".into(),
            input
                .correction_scope
                .map(|value| serialized(&value))
                .transpose()?
                .unwrap_or(Value::Null),
        );
        let request_sha256 = fingerprint("record_review", &Value::Object(identity))?;
        let expected_result_review_revision_id = if input.subject == ReviewSubject::Completion {
            accepted_review.map(|review| review.review_revision_id.clone())
        } else {
            None
        };
        let command = ReviewCommand {
            expected_plan_revision_id: plan.plan_revision_id.clone(),
            expected_progress_revision: context
                .work
                .latest_checkpoint
                .as_ref()
                .map_or(0, |checkpoint| checkpoint.revision),
            expected_result_sequence: context.work.result_refs.len() as u64,
            expected_result_review_revision_id,
            current_stage,
            entry_stage,
            next_stage,
            action_progress,
            progress_changed: input
                .action_updates
                .as_ref()
                .is_some_and(|updates| !updates.is_empty()),
            input,
            request_sha256,
        };
        self.repository.record_review(command).await
    }
}
