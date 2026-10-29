//! Source Work tool calls over the one bound durable Work service.

mod canon;
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
    child_tools: Option<Vec<String>>,
    canon: butler_turn::btcc::BtccStorage,
}

impl GuidedWorkTools {
    pub(crate) fn new(
        service: Arc<DurableWorkService>,
        scope: WorkTurnScope,
        canon: butler_turn::btcc::BtccStorage,
    ) -> Self {
        Self {
            service,
            scope,
            child_tools: None,
            canon,
        }
    }

    pub(crate) fn with_child_tools(mut self, tools: Option<Vec<String>>) -> Self {
        self.child_tools = tools;
        self
    }

    pub(crate) fn scope(&self) -> WorkTurnScope {
        self.scope.clone()
    }

    pub(crate) fn is_work_tool(name: &str) -> bool {
        matches!(
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
        if name == ToolName::RecordWorkDisposition
            && let Some(work) = self.bound_work().await?
            && args.get("work_id").and_then(Value::as_str) == Some(work.work_id.as_str())
            && settled_by_steward(&work)?
        {
            return Ok(json!({"ok":true,"already_settled":true,"work":view::success(&work)}));
        }
        if let Some(error) = self.handoff_rejection(args) {
            return Ok(self.rejected(error).await);
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
            Err(error) => self.rejected(source_error(&error)).await,
        })
    }

    /// A hand-back naming a tool this session can call is model input to
    /// correct, not a runtime fault: the model records its disposition again.
    fn handoff_rejection(&self, args: &Map<String, Value>) -> Option<Value> {
        let handoff = args.get("capability_handoff")?;
        let tool = handoff["requested_action"]["tool_name"]
            .as_str()
            .unwrap_or_default();
        let message = match &self.child_tools {
            None => "capability_handoff is only for a delegated session. Record the disposition again without it.".to_owned(),
            Some(tools) if tools.iter().any(|name| name == tool) => format!(
                "{tool} is granted in this session; capability_handoff is only for a tool this session lacks. Record the disposition again without capability_handoff, and say in the summary what failed."
            ),
            Some(_) => return None,
        };
        Some(json!({"code":"capability_handoff_rejected","message":message}))
    }

    /// A rejected Work call answers the model with the error and the current Work.
    async fn rejected(&self, error: Value) -> Value {
        let mut response = json!({"ok":false,"error":error});
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

    /// Source publication reads the bound Work after the journal commits the
    /// successful result. Plan replacement also binds its newly selected Work.
    pub(crate) async fn accepted_work(&self, name: &str) -> Result<Option<WorkView>, BtccError> {
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

    pub(crate) fn settled_disposition(work: &WorkView) -> Result<Option<Value>, BtccError> {
        let current = work.status == butler_turn::btcc::DurableWorkStatus::Abandoned
            || work.latest_disposition.as_ref().is_some_and(|disposition| {
                butler_turn::btcc::disposition_material_fingerprint(work)
                    .is_ok_and(|fingerprint| fingerprint == disposition.material_fingerprint)
            });
        Ok(current.then(|| json!({"ok":true,"already_settled":true,"work":view::success(work)})))
    }

    pub(crate) async fn bound_work(&self) -> Result<Option<WorkView>, BtccError> {
        self.service
            .bound_work_for_turn(self.scope.turn_id.clone())
            .await
    }

    async fn apply(&self, command: Command) -> Result<WorkView, BtccError> {
        match command {
            Command::Start(input) => self.service.start_work(input).await,
            Command::Continue(input) => self.service.continue_work(input).await,
            Command::Replace(input) => self.replace_canon_plan(input).await,
            Command::Checkpoint(input) => self.service.record_checkpoint(input).await,
            Command::Review(input) => self.service.record_review(input).await,
            Command::Disposition(input) => self.service.record_disposition(input).await,
        }
    }
}

fn settled_by_steward(work: &WorkView) -> Result<bool, BtccError> {
    if work.status == butler_turn::btcc::DurableWorkStatus::Abandoned {
        return Ok(true);
    }
    let Some(disposition) = &work.latest_disposition else {
        return Ok(false);
    };
    Ok(disposition
        .disposition_revision_id
        .starts_with("steward-result-disposition:")
        && disposition.material_fingerprint
            == butler_turn::btcc::disposition_material_fingerprint(work)?)
}

fn source_error(error: &BtccError) -> Value {
    if matches!(
        error.code(),
        "canon_epic_refs_multiple" | "canon_epic_not_bound" | "canon_epic_link_conflict"
    ) {
        return json!({"code":error.code(),"message":error.message()});
    }
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
