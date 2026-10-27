use std::sync::Arc;

use butler_core::tool_protocol::ToolName;
use serde_json::Value;
use tokio_util::sync::CancellationToken;

use crate::host::automation::client::ScheduleClient;
use butler_core::json::JsonDocument;
use butler_turn::btcc::{
    AdapterOutcome, BtccError, EffectAdapter, EffectAdapterError, EffectFailure, EffectFuture,
    PlanBinding,
};

use super::super::GuidedTools;

pub(super) fn supports(name: &str) -> bool {
    matches!(
        ToolName::parse(name),
        Some(
            ToolName::CreateAutomation
                | ToolName::UpdateAutomation
                | ToolName::DeleteAutomation
                | ToolName::RunDueAutomations
        )
    )
}

pub(super) async fn prepare(
    owner: &GuidedTools,
    call: &butler_turn::btcc::ModelRoundToolCall,
    occurrence: &str,
) -> Result<(String, Value, Arc<dyn EffectAdapter>), BtccError> {
    // Public schema validation is the primary guard for create_automation (no access_mode).
    // Keep this clamp as defense in depth; update_automation exposes access_mode.
    if ToolName::parse(&call.name) == Some(ToolName::UpdateAutomation)
        && call
            .arguments
            .get("access_mode")
            .and_then(Value::as_str)
            .and_then(butler_turn::btcc::AccessMode::parse)
            .is_some_and(|mode| mode.rank() > owner.binding.access_mode.rank())
    {
        return Err(BtccError::relayed(
            "schedule_access_exceeds_turn",
            "Schedule access exceeds this turn.",
        ));
    }
    let target = match call.name.as_str() {
        "create_automation" => format!(
            "automation:create:{}",
            call.arguments
                .get("id")
                .and_then(Value::as_str)
                .filter(|value| !value.trim().is_empty())
                .unwrap_or(occurrence)
        ),
        "update_automation" | "delete_automation" => format!(
            "automation:{}:{}",
            call.name,
            call.arguments
                .get("id")
                .and_then(Value::as_str)
                .unwrap_or("")
        ),
        "run_due_automations" => format!(
            "automation:due:{}",
            call.arguments
                .get("now")
                .and_then(Value::as_str)
                .filter(|value| !value.trim().is_empty())
                .unwrap_or("now")
        ),
        _ => {
            return Err(BtccError::relayed(
                "automation_tool_unknown",
                "Automation tool unavailable",
            ));
        }
    };
    let mut input = Value::Object(call.arguments.clone());
    if call.name == ToolName::CreateAutomation {
        resolve_default(owner, occurrence, &mut input).await?;
    } else if call.name == ToolName::DeleteAutomation {
        resolve_delete(owner, occurrence, &mut input).await?;
    }
    let adapter = AutomationEffect {
        endpoint: owner.app_endpoint.clone(),
        session_id: owner
            .binding
            .app_session_id
            .clone()
            .unwrap_or_else(|| owner.binding.source_session_id.clone()),
        name: call.name.clone(),
        target: target.clone(),
    };
    Ok((target, input, Arc::new(adapter)))
}

struct AutomationEffect {
    endpoint: Arc<crate::host::ActiveAppEndpoint>,
    session_id: String,
    name: String,
    target: String,
}

impl EffectAdapter for AutomationEffect {
    fn capability(&self) -> &str {
        &self.name
    }

    fn binding(&self) -> PlanBinding {
        PlanBinding::AcceptedPlan
    }

    fn normalize_target(&self, target: &str) -> Result<String, EffectFailure> {
        if target == self.target {
            Ok(target.to_owned())
        } else {
            Err(policy("automation_target_mismatch"))
        }
    }

    fn sanitize_target(&self, target: &str) -> Result<String, EffectFailure> {
        self.normalize_target(target)?;
        Ok(match self.name.as_str() {
            "update_automation" | "delete_automation" => self.target.clone(),
            "run_due_automations" => "automations:due".into(),
            _ => "automations".into(),
        })
    }

    fn normalize_input(&self, input: &Value) -> Result<Value, EffectFailure> {
        input
            .is_object()
            .then(|| input.clone())
            .ok_or_else(|| policy("automation_input_invalid"))
    }

    fn dispatch<'a>(
        &'a self,
        target: &'a str,
        input: &'a Value,
        _: &'a str,
        signal: &'a CancellationToken,
    ) -> EffectFuture<'a, AdapterOutcome> {
        Box::pin(async move {
            if target != self.target {
                return Ok(AdapterOutcome::NotApplied(adapter(
                    "automation_target_mismatch",
                )));
            }
            if signal.is_cancelled() {
                return Ok(AdapterOutcome::NotApplied(adapter("automation_cancelled")));
            }
            let args = input
                .as_object()
                .cloned()
                .ok_or_else(|| policy("automation_input_invalid"))?;
            let result = match ScheduleClient::active(&self.endpoint) {
                Ok(client) => client.tool(&self.name, args, &self.session_id).await,
                Err(error) => Err(error),
            };
            match result {
                Ok(result) => JsonDocument::from_value(&result)
                    .map(AdapterOutcome::Applied)
                    .map_err(|error| EffectFailure::adapter(error.to_string()).with_source(error)),
                Err(error) => Ok(AdapterOutcome::NotApplied(EffectAdapterError::new(
                    error.code(),
                    error.message(),
                ))),
            }
        })
    }

    fn reconcile<'a>(
        &'a self,
        _: &'a str,
        _: &'a Value,
        _: &'a str,
        _: &'a CancellationToken,
        attempts: i64,
        _: Option<&'a butler_turn::btcc::EffectError>,
    ) -> EffectFuture<'a, AdapterOutcome> {
        Box::pin(async move {
            if attempts == 0 {
                return Ok(AdapterOutcome::NotApplied(adapter("not_applied")));
            }
            Ok(AdapterOutcome::Uncertain(Some(EffectAdapterError::new(
                "automation_reconciliation_required",
                "The automation operation may have applied; inspect the automation list before retrying.",
            ))))
        })
    }
}

fn policy(code: &str) -> EffectFailure {
    EffectFailure::policy(code.to_owned(), "Automation effect identity changed")
}

fn adapter(code: &str) -> EffectAdapterError {
    EffectAdapterError::new(code, "Automation effect was not applied")
}

async fn resolve_default(
    owner: &GuidedTools,
    occurrence: &str,
    input: &mut Value,
) -> Result<(), BtccError> {
    if restore_reviewed_input(owner, occurrence, input).await? {
        return Ok(());
    }
    let client = ScheduleClient::active(&owner.app_endpoint)
        .map_err(|e| BtccError::relayed("schedule_default_unavailable", e.message().to_owned()))?;
    let settings = client
        .request(reqwest::Method::GET, "/settings", None)
        .await
        .map_err(|e| BtccError::relayed("schedule_default_unavailable", e.message().to_owned()))?;
    let mode = settings.get("settings").unwrap_or(&settings)["schedule_access_mode"]
        .as_str()
        .and_then(butler_turn::btcc::AccessMode::parse)
        .ok_or_else(|| {
            BtccError::relayed(
                "schedule_default_unavailable",
                "Schedule permission unavailable.",
            )
        })?;
    input["access_mode"] = Value::String(mode.as_str().into());
    Ok(())
}

pub(super) async fn restore_reviewed_input(
    owner: &GuidedTools,
    occurrence: &str,
    input: &mut Value,
) -> Result<bool, BtccError> {
    // Keep the reviewed schedule facts on resume, even if the schedule or Settings changed.
    if super::super::access::resumes(owner, occurrence) {
        let stored = owner
            .authority
            .execution(butler_turn::btcc::AuthorityExecutionInput {
                owner_session_id: owner.binding.owner_session_id.clone(),
                request_ref: owner
                    .binding
                    .authority_request_ref
                    .clone()
                    .unwrap_or_default(),
                source_session_id: Some(owner.binding.source_session_id.clone()),
                client_message_id: None,
                turn_id: owner.binding.turn_id.clone(),
            })
            .await
            .map_err(BtccError::from)?;
        *input = stored.normalized_input;
        return Ok(true);
    }
    Ok(false)
}

async fn resolve_delete(
    owner: &GuidedTools,
    occurrence: &str,
    input: &mut Value,
) -> Result<(), BtccError> {
    if restore_reviewed_input(owner, occurrence, input).await? {
        return Ok(());
    }
    // Schedule facts come from App storage, never model-supplied arguments.
    if let Some(args) = input.as_object_mut() {
        args.remove("schedule");
    }
    let id = input["id"].as_str().unwrap_or("");
    let client = ScheduleClient::active(&owner.app_endpoint)
        .map_err(|e| BtccError::relayed(e.code().to_owned(), e.message().to_owned()))?;
    let result = client.read(id).await;
    match result {
        Ok(data) => {
            let stored = &data["automation"];
            input["schedule"] = serde_json::json!({
                "title": stored["title"], "schedule_type": stored["schedule_type"],
                "run_at": stored["run_at"], "start_at": stored["start_at"],
                "interval_seconds": stored["interval_seconds"], "access_mode": stored["access_mode"],
                "browser_signin": stored["browser_signin"], "browser_payment": stored["browser_payment"],
            });
            Ok(())
        }
        Err(error) if error.code() == "automation_not_found" => Ok(()),
        Err(error) => Err(BtccError::relayed(
            error.code().to_owned(),
            error.message().to_owned(),
        )),
    }
}
