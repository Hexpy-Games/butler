use std::sync::Arc;

use serde_json::{Map, Value, json};
use tokio_util::sync::CancellationToken;

use crate::{
    btcc::{
        AdapterOutcome, EffectAdapter, EffectAdapterError, EffectFailure, EffectFuture, PlanBinding,
    },
    json::JsonDocument,
};

use super::super::NativeGuidedTools;

pub(super) fn supports(name: &str) -> bool {
    name == "call_mcp_tool"
}

pub(super) fn prepare(
    owner: &NativeGuidedTools,
    args: &Map<String, Value>,
) -> Result<(String, Value, Arc<dyn EffectAdapter>), crate::btcc::BtccError> {
    let server_id = required_text(args, "server_id")?;
    let tool_name = required_text(args, "tool_name")?;
    let arguments = args
        .get("arguments")
        .and_then(Value::as_object)
        .cloned()
        .unwrap_or_default();
    let (server_id, tool_name, arguments) = owner
        .mcp_client
        .prepare_tool_call(server_id, tool_name, arguments)
        .map_err(|error| crate::btcc::BtccError::new(error.code, error.message))?;
    let target = format!("mcp:{server_id}/{tool_name}");
    let input = json!({
        "server_id": server_id,
        "tool_name": tool_name,
        "arguments": arguments,
    });
    let adapter = McpToolEffect {
        client: owner.mcp_client.clone(),
        server_id,
        tool_name,
        target: target.clone(),
    };
    Ok((target, input, Arc::new(adapter)))
}

struct McpToolEffect {
    client: Arc<crate::mcp_client::NativeMcpClient>,
    server_id: String,
    tool_name: String,
    target: String,
}

impl EffectAdapter for McpToolEffect {
    fn capability(&self) -> &str {
        "call_mcp_tool"
    }

    fn binding(&self) -> PlanBinding {
        PlanBinding::AcceptedPlan
    }

    fn normalize_target(&self, target: &str) -> Result<String, EffectFailure> {
        if target == self.target {
            Ok(self.target.clone())
        } else {
            Err(policy("mcp_tool_target_invalid"))
        }
    }

    fn sanitize_target(&self, target: &str) -> Result<String, EffectFailure> {
        self.normalize_target(target)
    }

    fn normalize_input(&self, input: &Value) -> Result<Value, EffectFailure> {
        let Some(object) = input.as_object() else {
            return Err(policy("mcp_tool_input_invalid"));
        };
        let valid = object.get("server_id").and_then(Value::as_str) == Some(&self.server_id)
            && object.get("tool_name").and_then(Value::as_str) == Some(&self.tool_name)
            && object.get("arguments").is_some_and(Value::is_object);
        if valid {
            Ok(input.clone())
        } else {
            Err(policy("mcp_tool_input_invalid"))
        }
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
                    "mcp_tool_target_invalid",
                )));
            }
            if signal.is_cancelled() {
                return Ok(AdapterOutcome::NotApplied(adapter("mcp_tool_cancelled")));
            }
            let Some(arguments) = input.get("arguments").and_then(Value::as_object).cloned() else {
                return Ok(AdapterOutcome::NotApplied(adapter(
                    "mcp_tool_input_invalid",
                )));
            };
            match self
                .client
                .call_tool(&self.server_id, &self.tool_name, arguments, signal)
                .await
            {
                Ok(result) => JsonDocument::from_value(&result)
                    .map(AdapterOutcome::Applied)
                    .map_err(|error| EffectFailure::adapter(error.to_string())),
                Err(error) if error.attempted => Ok(AdapterOutcome::Uncertain(Some(
                    EffectAdapterError::new(error.code, error.message),
                ))),
                Err(error) => Ok(AdapterOutcome::NotApplied(EffectAdapterError::new(
                    error.code,
                    error.message,
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
        _: Option<&'a crate::btcc::EffectError>,
    ) -> EffectFuture<'a, AdapterOutcome> {
        Box::pin(async move {
            if attempts > 0 {
                Ok(AdapterOutcome::Uncertain(Some(EffectAdapterError::new(
                    "mcp_tool_reconciliation_unavailable",
                    "MCP tool reconciliation is unavailable; the remote outcome may be unknown.",
                ))))
            } else {
                Ok(AdapterOutcome::NotApplied(adapter(
                    "mcp_tool_not_dispatched",
                )))
            }
        })
    }
}

fn required_text<'a>(
    args: &'a Map<String, Value>,
    key: &str,
) -> Result<&'a str, crate::btcc::BtccError> {
    args.get(key)
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .ok_or_else(|| {
            crate::btcc::BtccError::new("mcp_tool_input_invalid", "MCP tool inputs are invalid.")
        })
}

fn policy(code: &str) -> EffectFailure {
    EffectFailure::policy(code, "MCP effect identity is invalid.")
}

fn adapter(code: &str) -> EffectAdapterError {
    EffectAdapterError::new(code, "MCP tool effect was not applied.")
}
