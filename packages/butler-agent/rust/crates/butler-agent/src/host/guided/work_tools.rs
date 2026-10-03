//! Source Work tool calls over the one bound durable Work service.

mod decode;
mod view;

use butler_core::tool_protocol::ToolName;
use std::sync::Arc;

use serde_json::{Map, Value, json};

use butler_turn::btcc::{BtccError, DurableWorkService, WorkTurnScope, WorkView};

use decode::Command;

pub(crate) struct GuidedWorkTools {
    service: Arc<DurableWorkService>,
    scope: WorkTurnScope,
}

impl GuidedWorkTools {
    pub(crate) fn new(service: Arc<DurableWorkService>, scope: WorkTurnScope) -> Self {
        Self { service, scope }
    }

    pub(crate) fn is_work_tool(name: &str) -> bool {
        super::work_model::tool(name)
            || matches!(
                ToolName::parse(name),
                Some(
                    ToolName::StartWork
                        | ToolName::ContinueWork
                        | ToolName::ReplaceWorkPlan
                        | ToolName::RecordWorkCheckpoint
                        | ToolName::RecordWorkReview
                        | ToolName::RecordWorkDisposition
                )
            )
    }

    pub(crate) fn repairs_completed_relation(name: &str) -> bool {
        matches!(
            ToolName::parse(name),
            Some(ToolName::StartWork | ToolName::ContinueWork | ToolName::ReplaceWorkPlan)
        )
    }

    pub(crate) async fn execute(
        &self,
        turn_id: &str,
        name: &str,
        args: &Map<String, Value>,
        mutation_call_id: &str,
        prior_tool_call_ids: &[String],
        expected_material_fingerprint: Option<&str>,
    ) -> Result<Value, BtccError> {
        if super::work_model::tool(name) {
            return super::work_model::execute(
                &self.service,
                &self.scope,
                name,
                args,
                mutation_call_id,
            )
            .await;
        }
        if turn_id != self.scope.turn_id {
            return Err(BtccError::relayed(
                "guided_work_tool_turn_mismatch",
                "Work tool owner belongs to a different Turn",
            ));
        }
        if !Self::is_work_tool(name) {
            return Err(BtccError::relayed(
                "guided_work_tool_unknown",
                "This is not a durable Work tool",
            ));
        }
        // Source safeBindOpenWork runs outside the tool result catch for these
        // non-relationship mutations; it must not silently choose unrelated Work.
        if !matches!(
            ToolName::parse(name),
            Some(ToolName::StartWork | ToolName::ContinueWork | ToolName::ReplaceWorkPlan)
        ) {
            self.service
                .bind_open_work(self.scope.clone(), None)
                .await?;
        }
        let command = decode::command(
            name,
            args,
            self.scope.clone(),
            mutation_call_id,
            prior_tool_call_ids,
            expected_material_fingerprint,
        );
        let result = match command {
            Ok(command) => self.apply(command).await,
            Err(message) => Err(BtccError::relayed(
                "work_tool_decode_rejected",
                message.to_string(),
            )),
        };
        Ok(match result {
            Ok(work) => json!({"ok":true,"work":view::success(&work)}),
            Err(error) => {
                let mut response = json!({"ok":false,"error":source_error(&error)});
                if let Some(context) = self
                    .service
                    .load_context(self.scope.clone())
                    .await
                    .ok()
                    .flatten()
                {
                    response["work"] = view::current(&context.work);
                }
                response
            }
        })
    }

    /// Source publication reads the bound Work after the journal commits the
    /// successful result. Plan replacement also binds its newly selected Work.
    pub(crate) async fn accepted_work(&self, name: &str) -> Result<Option<WorkView>, BtccError> {
        if super::work_model::tool(name) {
            return Ok(None);
        }
        if !Self::is_work_tool(name) {
            return Ok(None);
        }
        if name == ToolName::ReplaceWorkPlan {
            self.service
                .bind_open_work(self.scope.clone(), None)
                .await?;
        }
        self.bound_work().await
    }

    pub(crate) async fn bound_work(&self) -> Result<Option<WorkView>, BtccError> {
        self.service
            .bound_work_for_turn(self.scope.turn_id.clone())
            .await
    }

    pub(in crate::host) async fn effect_grant(
        &self,
    ) -> Result<Option<butler_turn::btcc::work_model::WorkModelEffectGrant>, BtccError> {
        match self.service.work_model() {
            Some(model) => model
                .effect_grant(self.scope.session_id.clone(), self.scope.turn_id.clone())
                .await
                .map(Some),
            None => Ok(None),
        }
    }

    pub(super) fn work_model(
        &self,
    ) -> Option<&Arc<butler_turn::btcc::work_model::WorkModelService>> {
        self.service.work_model()
    }

    pub(in crate::host) fn managed(&self) -> bool {
        self.service.work_model().is_some()
    }

    pub(in crate::host) async fn managed_guard(&self, name: &str) -> Result<(), BtccError> {
        super::work_model::guard(&self.service, &self.scope.session_id, name).await
    }

    async fn apply(&self, command: Command) -> Result<WorkView, BtccError> {
        match command {
            Command::Start(input) => self.service.start_work(input).await,
            Command::Continue(input) => self.service.continue_work(input).await,
            Command::Replace(input) => self.service.replace_plan(input).await,
            Command::Checkpoint(input) => self.service.record_checkpoint(input).await,
            Command::Review(input) => self.service.record_review(input).await,
            Command::Disposition(input) => self.service.record_disposition(input).await,
        }
    }
}

fn source_error(error: &BtccError) -> Value {
    if error.code() == "work_transition_guard_unmet"
        && let Some(rest) = error.message().strip_prefix("Work cannot ")
        && let Some((requested, rest)) = rest.split_once(" from ")
        && let Some((stage, rest)) = rest.split_once("; ")
        && let Some((unmet, next)) = rest.split_once(". Next action: ")
    {
        return json!({"code":error.code(),"message":error.message(),
            "current_stage":stage,"requested_action":requested,
            "unmet_guard":unmet,"next_action":next});
    }
    json!({"code":"work_update_rejected","message":error.message()})
}
