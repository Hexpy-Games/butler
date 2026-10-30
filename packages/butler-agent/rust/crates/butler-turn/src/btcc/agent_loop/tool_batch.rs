use futures_util::future::join_all;
use serde::Deserialize;
use serde_json::{Map, Value};

use crate::btcc::BtccError;
use butler_core::json::JsonDocument;

use super::contracts::{ModelRoundTool, ModelRoundToolCall, ToolCallOrigin, ToolError, ToolResult};
use super::guided_ports::GuidedInvocation;
use super::ports::{GuidedPolicyPort, ToolExecutionError};
use super::progress::{Status, operation};
use crate::btcc::BtccCode;

/// Execution metadata computed once, including the parsed authority request.
pub(super) struct ExecutedCall {
    pub result: ToolResult,
    pub pending_authority: Option<String>,
}

impl PreparedCall<'_> {
    fn visible(&self) -> bool {
        self.tool
            .is_none_or(|tool| tool.transcript_visibility.as_deref() != Some("hidden"))
    }
}

impl ExecutedCall {
    pub(super) fn restored(result: ToolResult) -> Self {
        let pending_authority = super::continuation::pending_authority(result.output.as_ref());
        Self {
            result,
            pending_authority,
        }
    }

    pub(super) fn settled(result: ToolResult) -> Self {
        Self {
            result,
            pending_authority: None,
        }
    }
}

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
    if call.origin == Some(ToolCallOrigin::Truncated) {
        return PreparedCall {
            call: call.clone(),
            tool,
            validation: Some(tool_error(
                "output_truncated",
                "Your output reached the output token limit while writing this call's arguments, so the call was cut off and not run. Retry in smaller steps, for example by splitting large content across several calls.".into(),
                None,
            )),
        };
    }
    let (arguments, validation) = match tool {
        None => (
            call.arguments.clone(),
            Some(tool_error(
                "tool_unavailable",
                format!(
                    "No such tool available: {}. Choose an available tool: {}.",
                    call.name,
                    tools
                        .iter()
                        .map(|tool| tool.name.as_str())
                        .collect::<Vec<_>>()
                        .join(", ")
                ),
                None,
            )),
        ),
        Some(tool) => prepare_arguments(tool, call),
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

/// Whether a fresh batch may run concurrently: more than one call, all valid,
/// and each either declared concurrency-safe or a tab-scoped browser call.
/// Browser calls claim their tab exclusively; concurrency-safe calls naming a
/// tab claim it shared. Any overlap with an exclusive claim keeps the entire
/// batch in call order. Shared reads and different tabs may run concurrently.
/// Resumed batches always run in order.
pub(super) fn concurrent(calls: &[PreparedCall<'_>]) -> bool {
    let mut tabs = std::collections::HashMap::new();
    calls.len() > 1
        && calls.iter().all(|prepared| {
            if prepared.validation.is_some() {
                return false;
            }
            let (tab, exclusive) = match browser_tab(&prepared.call) {
                Some(tab) => (tab, true),
                None if prepared
                    .tool
                    .is_some_and(|tool| tool.concurrency_safe == Some(true)) =>
                {
                    (
                        prepared
                            .call
                            .arguments
                            .get("tab")
                            .and_then(Value::as_str)
                            .map(str::to_owned),
                        false,
                    )
                }
                None => return false,
            };
            tab.is_none_or(|tab| {
                tabs.insert(tab, exclusive)
                    .is_none_or(|previous| !previous && !exclusive)
            })
        })
}

/// The tab a tab-scoped browser call drives: `Some(None)` for a new tab,
/// `None` for anything else. A `tool_call` bridge resolves to its target.
fn browser_tab(call: &ModelRoundToolCall) -> Option<Option<String>> {
    let (name, arguments) = if call.name == "tool_call" {
        let id = call.arguments.get("id")?.as_str()?;
        let arguments = call.arguments.get("arguments")?.as_object()?;
        (id.strip_prefix("native:")?, arguments)
    } else {
        (call.name.as_str(), &call.arguments)
    };
    match name {
        "browser_open" => Some(None),
        "browser_observe" | "browser_act" | "browser_screenshot" | "browser_devtools"
        | "browser_close" => Some(Some(arguments.get("tab")?.as_str()?.to_owned())),
        _ => None,
    }
}

#[tracing::instrument(name = "tool.call", skip_all, fields(name = %policy.hook_tool_name(&prepared.call), status = tracing::field::Empty), err)]
pub(super) async fn execute<'a>(
    policy: &'a dyn GuidedPolicyPort,
    invocation: GuidedInvocation<'a>,
    prepared: &'a PreparedCall<'a>,
) -> Result<ExecutedCall, BtccError> {
    visible_operation(
        prepared,
        invocation.progress,
        &prepared.call,
        Status::Started,
        None,
        None,
    )
    .await?;
    tracing::trace!(category = "tool", event = "tool.input", content_json = %serde_json::Value::Object(prepared.call.arguments.clone()), "Tool input");
    if let Some(error) = &prepared.validation {
        tracing::error!(category = "tool", event = "tool.failed", code = %error.code, "Tool validation failed");
        let result = ToolResult {
            tool_call_id: prepared.call.id.clone(),
            name: prepared.call.name.clone(),
            ok: false,
            error: Some(error.clone()),
            output: None,
        };
        visible_operation(
            prepared,
            invocation.progress,
            &prepared.call,
            Status::Failed,
            None,
            None,
        )
        .await?;
        super::hooks::post_tool(policy, invocation, &prepared.call, &result).await;
        return Ok(ExecutedCall::settled(result));
    }
    let denied = super::hooks::pre_tool(policy, invocation, &prepared.call).await;
    let mut result = if let Some(message) = denied {
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
    enrich_rejection(&mut result, prepared);
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
    // A pending body is visible only after the continuation commit succeeds.
    let executed = ExecutedCall::restored(result);
    if executed.pending_authority.is_none() {
        publish_result(policy, invocation, prepared, &executed.result).await?;
    }
    tracing::trace!(
        category = "tool",
        event = "tool.output",
        content_json = executed
            .result
            .output
            .as_ref()
            .map(JsonDocument::as_str)
            .unwrap_or("null"),
        "Tool output"
    );
    if !executed.result.ok {
        tracing::error!(category = "tool", event = "tool.failed", "Tool failed");
    }
    Ok(executed)
}

async fn publish_result(
    policy: &dyn GuidedPolicyPort,
    invocation: GuidedInvocation<'_>,
    prepared: &PreparedCall<'_>,
    result: &ToolResult,
) -> Result<(), BtccError> {
    let visible = result
        .error
        .as_ref()
        .filter(|e| e.code == "hook_denied")
        .map(|_| denied_operation(policy, &prepared.call));
    let operation_call_id = policy.operation_result_call_id(&prepared.call.id);
    visible_operation(
        prepared,
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
    .await
}

fn enrich_rejection(result: &mut ToolResult, prepared: &PreparedCall<'_>) {
    if result
        .error
        .as_ref()
        .is_some_and(|error| error.code == "invalid_arguments")
    {
        return;
    }
    if result
        .output
        .as_ref()
        .and_then(|output| output.field("error").ok().flatten())
        .and_then(|raw| serde_json::from_str::<Value>(raw).ok())
        .is_some_and(|error| error.get("problems").is_some_and(Value::is_array))
    {
        return;
    }
    if let Some(error) = &mut result.error {
        let schema = prepared.tool.map(|tool| &tool.parameters);
        error.message.push_str(&format!(
            " Correct the input using this schema: {}. Resolve prerequisites from the returned state, choose another available tool, or wait for an active dependency; do not repeat the unchanged failure.",
            serde_json::to_string(&schema).unwrap_or_default()
        ));
    }
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
            super::progress::report_unpublished(
                visible_operation(
                    prepared,
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
                .await,
            );
            return Err(error);
        }
    };
    Ok(result)
}

pub(super) async fn execute_concurrent<'a>(
    policy: &'a dyn GuidedPolicyPort,
    invocation: GuidedInvocation<'a>,
    calls: &'a [PreparedCall<'a>],
) -> Result<Vec<ExecutedCall>, BtccError> {
    let results = join_all(
        calls
            .iter()
            .map(|prepared| execute(policy, invocation, prepared)),
    )
    .await;
    if results.iter().any(Result::is_err) {
        for (call, result) in calls.iter().zip(&results) {
            if result
                .as_ref()
                .is_ok_and(|result| result.pending_authority.is_some())
            {
                super::progress::report_unpublished(
                    super::progress::authority_terminal(
                        invocation.progress,
                        &call.call,
                        Status::Failed,
                    )
                    .await,
                );
            }
        }
    }
    results.into_iter().collect()
}

fn prepare_arguments(
    tool: &ModelRoundTool,
    call: &ModelRoundToolCall,
) -> (Map<String, Value>, Option<ToolError>) {
    use crate::btcc::tool_arguments::{decode_object, normalize_direct_arguments};
    let parsed = decode_object(&call.raw_arguments)
        .map(Value::Object)
        .unwrap_or(Value::Null);
    if tool.handler_validates_arguments == Some(true)
        && let Some(arguments) = parsed.as_object()
    {
        return (arguments.clone(), None);
    }
    match normalize_direct_arguments(&call.name, &Value::Object(tool.parameters.clone()), &parsed) {
        Ok(arguments) => (arguments, None),
        Err((message, field)) => (
            call.arguments.clone(),
            Some(tool_error("invalid_arguments", message, Some(field))),
        ),
    }
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

async fn visible_operation(
    prepared: &PreparedCall<'_>,
    progress: &dyn crate::btcc::AgentLoopProgress,
    call: &ModelRoundToolCall,
    status: Status,
    output: Option<&JsonDocument>,
    operation_call_id: Option<&str>,
) -> Result<(), BtccError> {
    if prepared.visible() {
        operation(progress, call, status, output, operation_call_id).await?;
    }
    Ok(())
}
