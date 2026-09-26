use futures_util::future::join_all;
use serde::Deserialize;
use serde_json::{Map, Value};

use crate::btcc::BtccError;
use crate::json::JsonDocument;

use super::contracts::{ModelRoundTool, ModelRoundToolCall, ToolError, ToolResult};
use super::guided_ports::GuidedInvocation;
use super::ports::{GuidedPolicyPort, ToolExecutionError};
use super::progress::{Status, operation};

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

pub(super) fn concurrent(calls: &[PreparedCall<'_>], resumed: bool) -> bool {
    !resumed
        && calls.len() > 1
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
        &prepared.call.id,
        &prepared.call.name,
        Status::Started,
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
            &prepared.call.id,
            &prepared.call.name,
            Status::Failed,
            None,
        )
        .await;
        return Ok(result);
    }
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
                &prepared.call.id,
                &prepared.call.name,
                if invocation.cancellation.is_cancelled() {
                    Status::Cancelled
                } else {
                    Status::Failed
                },
                None,
            )
            .await;
            return Err(error);
        }
    };
    operation(
        invocation.progress,
        &prepared.call.id,
        &prepared.call.name,
        if result.ok {
            Status::Completed
        } else {
            Status::Failed
        },
        result.output.as_ref(),
    )
    .await;
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
    schema: &Map<String, Value>,
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
        output
            .field(name)
            .map_err(|e| BtccError::new("tool_result_json", e.to_string()))
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
