use serde_json::Value;

use crate::btcc::BtccError;

use super::{DurableWorkService, fingerprint, object_mut, serialized};
use crate::btcc::BtccCode;
use crate::btcc::work::contracts::*;

impl DurableWorkService {
    pub(crate) async fn start_work(&self, input: StartWorkInput) -> Result<WorkView, BtccError> {
        super::super::validation::validate_start(&input)?;
        let mut identity = serialized(&input)?;
        object_mut(&mut identity)?.remove("backfillToolCallIds");
        let request_sha256 = fingerprint("start_work", &identity)?;
        self.repository
            .start_work(StartWorkCommand {
                input,
                request_sha256,
            })
            .await
    }

    pub(crate) async fn continue_work(
        &self,
        input: ContinueWorkInput,
    ) -> Result<WorkView, BtccError> {
        super::super::validation::validate_continue(&input)?;
        let mut identity = serialized(&input)?;
        object_mut(&mut identity)?.remove("backfillToolCallIds");
        let request_sha256 = fingerprint("continue_work", &identity)?;
        self.repository
            .continue_work(ContinueWorkCommand {
                input,
                request_sha256,
            })
            .await
    }

    pub(crate) async fn replace_plan(
        &self,
        input: ReplacePlanInput,
    ) -> Result<WorkView, BtccError> {
        super::super::validation::validate_replace(&input)?;
        let start_new = input.start_new.unwrap_or(false);
        let context = if start_new {
            None
        } else {
            self.repository.load_context(input.scope.clone()).await?
        };
        let opening_plan = context
            .as_ref()
            .and_then(|value| value.work.current_plan.as_ref())
            .is_none();
        if context.as_ref().is_some_and(|value| {
            !matches!(value.work.status, WorkStatus::Open | WorkStatus::Blocked)
        }) {
            return Err(BtccError::detected(
                BtccCode::DurableWorkTerminalRelation,
                "Durable Work relation is already selected for a terminal Work; start new Work in a fresh Turn",
            ));
        }
        let governing_refs = input.governing_refs.clone().unwrap_or_default();
        let mut identity = serde_json::Map::new();
        super::with_null_project(&input.scope, &mut identity);
        identity.insert(
            "mutationCallId".into(),
            Value::String(input.mutation_call_id.clone()),
        );
        identity.insert("startNew".into(), Value::Bool(start_new));
        identity.insert("objective".into(), Value::String(input.objective.clone()));
        identity.insert("governingRefs".into(), serialized(&governing_refs)?);
        if let Some(mode) = input.execution_mode {
            identity.insert("executionMode".into(), serialized(&mode)?);
        }
        identity.insert("actions".into(), serialized(&input.actions)?);
        identity.insert("checks".into(), serialized(&input.checks)?);
        let request_sha256 = fingerprint("replace_plan", &Value::Object(identity))?;
        let expected_work_id = context.as_ref().map(|value| value.work.work_id.clone());
        let expected_progress_revision = context.as_ref().map(|value| {
            value
                .work
                .latest_checkpoint
                .as_ref()
                .map_or(0, |checkpoint| checkpoint.revision)
        });
        let action_progress = super::super::policy::progress_for_replacement_plan(
            &input.actions,
            context
                .as_ref()
                .map_or(&[][..], |value| value.work.action_progress.as_slice()),
        );
        self.repository
            .replace_plan(ReplacePlanCommand {
                input,
                request_sha256,
                start_new,
                governing_refs,
                expected_work_id,
                expected_progress_revision,
                action_progress,
                opening_plan,
            })
            .await
    }
}
