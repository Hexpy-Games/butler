use serde_json::Value;

use crate::btcc::BtccError;

use super::{DurableWorkService, fingerprint, object_mut, serialized};
use crate::btcc::BtccCode;
use crate::btcc::work::contracts::*;

impl DurableWorkService {
    /// Validates and starts new Work.
    pub async fn start_work(&self, input: StartWorkInput) -> Result<WorkView, BtccError> {
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

    pub(crate) async fn start_handoff_work(
        &self,
        input: StartWorkInput,
    ) -> Result<WorkView, BtccError> {
        super::super::validation::validate_start(&input)?;
        let request_sha256 = fingerprint("start_handoff_work", &serialized(&input)?)?;
        self.repository
            .start_handoff_work(StartWorkCommand {
                input,
                request_sha256,
            })
            .await
    }

    /// Validates and continues existing Work.
    pub async fn continue_work(&self, input: ContinueWorkInput) -> Result<WorkView, BtccError> {
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

    /// Validates and records a plan revision.
    pub async fn replace_plan(&self, mut input: ReplacePlanInput) -> Result<WorkView, BtccError> {
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
        carry_intent(
            &mut input.checks,
            context
                .as_ref()
                .and_then(|value| value.work.current_plan.as_ref()),
        );
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

/// A revision that states no Conception keeps the current Plan's intent
/// lines, so delegated work never loses Butler's reading of the request; a
/// revision with a `Goal:` line replaces them all. New Work has no current
/// Plan and inherits nothing.
fn carry_intent(checks: &mut Vec<String>, current: Option<&WorkPlan>) {
    if checks
        .iter()
        .any(|check| check.starts_with(PLAN_INTENT_LINES[0]))
    {
        return;
    }
    let Some(plan) = current else {
        return;
    };
    checks.extend(
        plan.checks
            .iter()
            .filter(|check| PLAN_INTENT_LINES.iter().any(|line| check.starts_with(line)))
            .cloned(),
    );
}
