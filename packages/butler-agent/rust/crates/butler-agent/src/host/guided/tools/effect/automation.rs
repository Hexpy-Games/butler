use std::sync::Arc;

use butler_core::tool_protocol::ToolName;
use serde_json::Value;
use tokio_util::sync::CancellationToken;

use butler_core::json::JsonDocument;
use butler_runtime::operations::AutomationService;
use butler_turn::btcc::AdapterOutcome;
use butler_turn::btcc::BtccError;
use butler_turn::btcc::EffectAdapter;
use butler_turn::btcc::EffectAdapterError;
use butler_turn::btcc::EffectFailure;
use butler_turn::btcc::EffectFuture;
use butler_turn::btcc::PlanBinding;

use super::super::GuidedTools;

pub(super) fn supports(name: &str) -> bool {
    matches!(
        ToolName::parse(name),
        Some(ToolName::CreateAutomation | ToolName::DeleteAutomation | ToolName::RunDueAutomations)
    )
}

pub(super) fn prepare(
    owner: &GuidedTools,
    call: &butler_turn::btcc::ModelRoundToolCall,
    occurrence: &str,
) -> Result<(String, Value, Arc<dyn EffectAdapter>), BtccError> {
    let target = match call.name.as_str() {
        "create_automation" => format!(
            "automation:create:{}",
            call.arguments
                .get("id")
                .and_then(Value::as_str)
                .filter(|value| !value.trim().is_empty())
                .unwrap_or(occurrence)
        ),
        "delete_automation" => format!(
            "automation:delete:{}",
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
    let input = Value::Object(call.arguments.clone());
    let adapter = AutomationEffect {
        service: owner.automations.clone(),
        session_id: owner.binding.source_session_id.clone(),
        name: call.name.clone(),
        target: target.clone(),
    };
    Ok((target, input, Arc::new(adapter)))
}

struct AutomationEffect {
    service: Arc<AutomationService>,
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
            "delete_automation" => self.target.clone(),
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
            match self
                .service
                .execute(&self.name, args, &self.session_id)
                .await
            {
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
