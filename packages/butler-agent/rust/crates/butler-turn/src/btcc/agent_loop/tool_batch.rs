use futures_util::future::join_all;
use serde::Deserialize;
use serde_json::{Map, Value};

use crate::btcc::BtccError;
use butler_core::json::JsonDocument;

use super::contracts::{ModelRoundTool, ModelRoundToolCall, ToolError, ToolResult};
use super::guided_ports::GuidedInvocation;
use super::ports::{GuidedPolicyPort, ToolExecutionError};
use super::progress::{Status, operation};
use crate::btcc::BtccCode;

pub(super) struct PreparedCall<'a> {
    pub call: ModelRoundToolCall,
    pub tool: Option<&'a ModelRoundTool>,
    pub validation: Option<ToolError>,
}

pub(super) fn prepare<'a>(
    tools: &'a [ModelRoundTool],
    call: &ModelRoundToolCall,
) -> PreparedCall<'a> {
    let tool = tools.iter().find(|tool| tool.name == call.name);
    let parsed = serde_json::from_str::<Value>(&call.raw_arguments)
        .ok()
        .and_then(|value| value.as_object().cloned());
    let (arguments, validation) = match (tool, parsed) {
        (None, _) => (
            call.arguments.clone(),
            Some(tool_error(
                "tool_unavailable",
                format!("No such tool available: {}", call.name),
                None,
            )),
        ),
        (Some(_), None) => (
            call.arguments.clone(),
            Some(tool_error(
                "invalid_arguments",
                "Tool arguments must be a JSON object".into(),
                None,
            )),
        ),
        (Some(tool), Some(arguments)) => {
            let error = validate_required(&tool.parameters, &arguments);
            (arguments, error)
        }
    };
    PreparedCall {
        call: ModelRoundToolCall {
            arguments,
            ..call.clone()
        },
        tool,
        validation,
    }
}

/// Whether a fresh batch may run concurrently: more than one call, all valid
/// and all declared concurrency-safe. Resumed batches always run in order.
pub(super) fn concurrent(calls: &[PreparedCall<'_>]) -> bool {
    calls.len() > 1
        && calls.iter().all(|prepared| {
            prepared.validation.is_none()
                && prepared
                    .tool
                    .is_some_and(|tool| tool.concurrency_safe == Some(true))
        })
}

pub(super) async fn execute<'a>(
    policy: &'a dyn GuidedPolicyPort,
    invocation: GuidedInvocation<'a>,
    prepared: &'a PreparedCall<'a>,
) -> Result<ToolResult, BtccError> {
    operation(
        invocation.progress,
        &prepared.call,
        Status::Started,
        None,
        None,
    )
    .await;
    if let Some(error) = &prepared.validation {
        let result = ToolResult {
            tool_call_id: prepared.call.id.clone(),
            name: prepared.call.name.clone(),
            ok: false,
            error: Some(error.clone()),
            output: None,
        };
        operation(
            invocation.progress,
            &prepared.call,
            Status::Failed,
            None,
            None,
        )
        .await;
        super::hooks::post_tool(policy, invocation, &prepared.call, &result).await;
        return Ok(result);
    }
    let denied = super::hooks::pre_tool(policy, invocation, &prepared.call).await;
    let result = if let Some(message) = denied {
        ToolResult {
            tool_call_id: prepared.call.id.clone(),
            name: prepared.call.name.clone(),
            ok: false,
            error: Some(tool_error("hook_denied", message, None)),
            output: None,
        }
    } else {
        execute_validated(policy, invocation, prepared).await?
    };
    if result
        .error
        .as_ref()
        .is_some_and(|error| error.code == "hook_denied")
    {
        policy
            .record_unexecuted(invocation, &prepared.call, &result)
            .await?;
    }
    super::hooks::post_tool(policy, invocation, &prepared.call, &result).await;
    let visible = result
        .error
        .as_ref()
        .filter(|e| e.code == "hook_denied")
        .map(|_| denied_operation(policy, &prepared.call));
    let operation_call_id = policy.operation_result_call_id(&prepared.call.id);
    operation(
        invocation.progress,
        visible.as_ref().unwrap_or(&prepared.call),
        if result.ok {
            Status::Completed
        } else {
            Status::Failed
        },
        result.output.as_ref(),
        operation_call_id.as_deref(),
    )
    .await;
    Ok(result)
}

fn denied_operation(
    policy: &dyn GuidedPolicyPort,
    call: &ModelRoundToolCall,
) -> ModelRoundToolCall {
    ModelRoundToolCall {
        name: policy.hook_tool_name(call).into_owned(),
        arguments: policy.hook_tool_input(call).clone(),
        ..call.clone()
    }
}

async fn execute_validated<'a>(
    policy: &'a dyn GuidedPolicyPort,
    invocation: GuidedInvocation<'a>,
    prepared: &'a PreparedCall<'a>,
) -> Result<ToolResult, BtccError> {
    let result = match policy
        .execute_tool(
            invocation,
            &prepared.call,
            prepared.tool.and_then(|tool| tool.tool_contract_version),
        )
        .await
    {
        Ok(output) => {
            let failure = resolved_failure(&output)?;
            ToolResult {
                tool_call_id: prepared.call.id.clone(),
                name: prepared.call.name.clone(),
                ok: failure.is_none(),
                error: failure,
                output: Some(output),
            }
        }
        Err(ToolExecutionError::Integrity(error)) => {
            operation(
                invocation.progress,
                &prepared.call,
                if invocation.cancellation.is_cancelled() {
                    Status::Cancelled
                } else {
                    Status::Failed
                },
                None,
                None,
            )
            .await;
            return Err(error);
        }
    };
    Ok(result)
}

pub(super) async fn execute_concurrent<'a>(
    policy: &'a dyn GuidedPolicyPort,
    invocation: GuidedInvocation<'a>,
    calls: &'a [PreparedCall<'a>],
) -> Result<Vec<ToolResult>, BtccError> {
    let results = join_all(
        calls
            .iter()
            .map(|prepared| execute(policy, invocation, prepared)),
    )
    .await;
    results.into_iter().collect()
}

fn validate_required(
    // Passthrough: tool arguments/results/schemas, shaped by each tool.
    schema: &Map<String, Value>,
    // Passthrough: tool arguments/results/schemas, shaped by each tool.
    arguments: &Map<String, Value>,
) -> Option<ToolError> {
    let required = schema.get("required").and_then(Value::as_array)?;
    for field in required.iter().filter_map(Value::as_str) {
        if !arguments.contains_key(field) {
            return Some(tool_error(
                "invalid_arguments",
                format!("Missing required field: {field}"),
                Some(field.into()),
            ));
        }
    }
    None
}

fn resolved_failure(output: &JsonDocument) -> Result<Option<ToolError>, BtccError> {
    let field = |name| {
        output.field(name).map_err(|e| {
            BtccError::detected(BtccCode::ToolResultJson, e.to_string()).with_source(e)
        })
    };
    if field("ok")? != Some("false") {
        return Ok(None);
    }
    #[derive(Deserialize)]
    struct ErrorView {
        code: Option<String>,
        message: Option<String>,
        field: Option<String>,
    }
    let nested = field("error")?
        .filter(|raw| raw.trim_start().starts_with('{'))
        .and_then(|raw| serde_json::from_str::<ErrorView>(raw).ok());
    let direct = field("error")?
        .filter(|raw| raw.trim_start().starts_with('"'))
        .and_then(|raw| serde_json::from_str::<String>(raw).ok());
    let message = field("message")?.and_then(|raw| serde_json::from_str::<String>(raw).ok());
    Ok(Some(tool_error(
        nested
            .as_ref()
            .and_then(|e| e.code.as_deref())
            .or(direct.as_deref())
            .unwrap_or("tool_failed"),
        nested
            .as_ref()
            .and_then(|e| e.message.clone())
            .or(message)
            .unwrap_or_else(|| "Tool failed.".into()),
        nested.as_ref().and_then(|e| e.field.clone()),
    )))
}

fn tool_error(code: &str, message: String, field: Option<String>) -> ToolError {
    ToolError {
        code: code.into(),
        message,
        field,
    }
}
