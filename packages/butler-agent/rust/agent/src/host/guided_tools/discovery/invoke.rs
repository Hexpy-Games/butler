//! One inner native invocation under the outer bridge occurrence.

use super::{NativeGuidedTools, bridge_error, encoded, projection, text};
use crate::btcc::{BtccError, GuidedInvocation, ModelRoundToolCall, ToolExecutionError};
use crate::capabilities::{describe_native, validate_native_arguments};
use crate::json::JsonDocument;
use serde_json::{Value, json};

pub(super) async fn run(
    owner: &NativeGuidedTools,
    invocation: GuidedInvocation<'_>,
    call: &ModelRoundToolCall,
    outer_call_id: &str,
) -> Result<JsonDocument, ToolExecutionError> {
    let Some(id) = text(&call.arguments, "id") else {
        return encoded(&bridge_error(
            "invalid_tool_catalog_id",
            "tool_call requires a non-empty catalog id.",
        ));
    };
    let Some(args) = call.arguments.get("arguments").and_then(Value::as_object) else {
        return encoded(&bridge_error(
            "invalid_tool_arguments",
            "tool_call arguments must be an object.",
        ));
    };
    if id.starts_with("mcp:") {
        return run_mcp(owner, invocation, call, outer_call_id, id, args).await;
    }
    let Some(name) = id
        .strip_prefix("native:")
        .filter(|name| !name.contains(':'))
    else {
        return encoded(&bridge_error(
            "unsupported_bridge_provider",
            "This native Turn cannot invoke MCP or plugin tools.",
        ));
    };
    let catalog = owner.catalog.snapshot();
    let Some(tool) = catalog.native_tool(name).filter(|_| {
        !catalog.hidden_native_bridge_tool(name, owner.binding.enable_project_ledger_effects)
    }) else {
        let mut error = bridge_error(
            "unknown_tool_catalog_id",
            &format!("Unknown tool catalog id: {id}"),
        );
        error["error"]["id"] = Value::String(id.into());
        return encoded(&error);
    };
    let description = describe_native(projection(owner, tool)).map_err(|error| {
        ToolExecutionError::Integrity(BtccError::new(
            "guided_bridge_catalog_json",
            error.to_string(),
        ))
    })?;
    if description.get("enabled") != Some(&Value::Bool(true)) {
        let reason = description
            .get("disabled_reason")
            .and_then(Value::as_str)
            .unwrap_or("Tool is disabled.");
        let alternatives = if description.get("category").and_then(Value::as_str) == Some("search")
        {
            vec!["tool_search", "web_read"]
        } else {
            vec!["tool_search"]
        };
        let next_action = "Treat this as a recoverable tool-selection result, not an app failure. Choose an enabled alternative when it can satisfy the same goal. If this exact disabled capability is required, explain the limitation and continue with available evidence.";
        let recovery =
            json!({"reason":reason,"alternatives":alternatives,"next_action":next_action});
        let mut error = bridge_error("disabled_tool", reason);
        error["error"]["id"] = Value::String(id.into());
        error["error"]["reason"] = Value::String(reason.into());
        error["error"]["alternatives"] = json!(alternatives);
        error["error"]["next_action"] = Value::String(next_action.into());
        error["error"]["recovery"] = recovery;
        return encoded(&error);
    }
    // Source permits an already authorized current tool without a prior describe.
    if !owner.binding.authorized_names.contains(name)
        && !owner.state.lock().described_ids.contains(id)
    {
        let mut error = bridge_error(
            "tool_not_described",
            &format!("Tool must be described before invocation: {id}"),
        );
        error["error"]["id"] = Value::String(id.into());
        error["error"]["next_action"] = Value::String("Call tool_describe for this exact catalog id, inspect the schema, then retry tool_call with schema-valid arguments.".into());
        return encoded(&error);
    }
    if matches!(name, "tool_search" | "tool_describe" | "tool_call") {
        return encoded(&bridge_error(
            "forbidden_bridge_target",
            "Bridge tools cannot recursively invoke bridge tools.",
        ));
    }
    if let Err((message, path)) =
        validate_native_arguments(&Value::Object(args.clone()), &description["schema"])
    {
        let mut error = bridge_error("invalid_tool_arguments", &message);
        error["error"]["id"] = Value::String(id.into());
        error["error"]["path"] = Value::String(path);
        return encoded(&error);
    }
    let raw_arguments = crate::json::stringify(&Value::Object(args.clone())).map_err(|error| {
        ToolExecutionError::Integrity(BtccError::new(
            "guided_bridge_arguments_json",
            error.to_string(),
        ))
    })?;
    let inner = ModelRoundToolCall {
        id: call.id.clone(),
        name: name.into(),
        arguments: args.clone(),
        raw_arguments,
        origin: call.origin,
    };
    // Dispatch through the existing guarded domain owner. Never recurse into
    // ToolPort::execute: that would create a second journal occurrence.
    let result = if name == "read_operation_results" {
        let Some(runtime) = invocation.operation_results else {
            return encoded(&underlying(id, "operation_result_exact_read_unavailable"));
        };
        let value = match runtime.read_tool(&inner.arguments).await {
            Ok(value) => value,
            Err(error) => return encoded(&underlying(id, &error.code)),
        };
        JsonDocument::from_value(&value).map_err(|error| {
            ToolExecutionError::Integrity(BtccError::new(
                "guided_bridge_result_json",
                error.to_string(),
            ))
        })?
    } else {
        match Box::pin(super::super::dispatch::execute(
            owner,
            invocation,
            &inner,
            outer_call_id,
        ))
        .await
        {
            Ok(value) => value,
            Err(error) => {
                let ToolExecutionError::Integrity(ref error) = error;
                let code = error.code.as_str();
                return encoded(&underlying(id, code));
            }
        }
    };
    attach_bridge_invocation(
        result,
        json!({"id":id,"provider":"native","affordance":"native_tool"}),
    )
}

async fn run_mcp(
    owner: &NativeGuidedTools,
    invocation: GuidedInvocation<'_>,
    call: &ModelRoundToolCall,
    outer_call_id: &str,
    id: &str,
    args: &serde_json::Map<String, Value>,
) -> Result<JsonDocument, ToolExecutionError> {
    let Some(parsed) = crate::mcp_client::parse_mcp_catalog_id(id) else {
        let mut error = bridge_error("unknown_tool_catalog_id", "Unknown tool catalog id.");
        error["error"]["id"] = Value::String(id.into());
        return encoded(&error);
    };
    let call_available = owner.binding.authorized_names.contains("call_mcp_tool");
    let description = match crate::mcp_client::describe_mcp_tool(
        &owner.mcp_client,
        id,
        &parsed.server_id,
        &parsed.tool_name,
        call_available,
        invocation.cancellation,
    )
    .await
    {
        Ok(Some(description)) => description,
        Ok(None) => {
            let mut error = bridge_error("unknown_tool_catalog_id", "Unknown tool catalog id.");
            error["error"]["id"] = Value::String(id.into());
            return encoded(&error);
        }
        Err(error) => return encoded(&underlying(id, error.code)),
    };
    if description.get("enabled") != Some(&Value::Bool(true)) {
        let reason = description
            .get("disabled_reason")
            .and_then(Value::as_str)
            .unwrap_or("MCP tool is disabled.");
        let alternatives = ["tool_search", "list_mcp_capabilities"];
        let mut error = bridge_error("disabled_tool", reason);
        error["error"]["id"] = Value::String(id.into());
        error["error"]["reason"] = Value::String(reason.into());
        error["error"]["alternatives"] = json!(alternatives);
        error["error"]["next_action"] = Value::String(
            "Treat this as a recoverable tool-selection result. Choose an enabled alternative or continue with available evidence.".into(),
        );
        return encoded(&error);
    }
    if !owner.binding.visible_names.contains(&parsed.tool_name)
        && !owner.state.lock().described_ids.contains(id)
    {
        let mut error = bridge_error(
            "tool_not_described",
            &format!("Tool must be described before invocation: {id}"),
        );
        error["error"]["id"] = Value::String(id.into());
        error["error"]["next_action"] = Value::String(
            "Call tool_describe for this exact catalog id, inspect the schema, then retry tool_call with schema-valid arguments.".into(),
        );
        return encoded(&error);
    }
    let schema = description
        .get("schema")
        .cloned()
        .unwrap_or_else(|| json!({}));
    if let Err((message, path)) = validate_native_arguments(&Value::Object(args.clone()), &schema) {
        let mut error = bridge_error("invalid_tool_arguments", &message);
        error["error"]["id"] = Value::String(id.into());
        error["error"]["path"] = Value::String(path);
        return encoded(&error);
    }
    let inner_arguments = serde_json::from_value::<serde_json::Map<String, Value>>(json!({
        "server_id":parsed.server_id,
        "tool_name":parsed.tool_name,
        "arguments":args,
    }))
    .map_err(|error| {
        ToolExecutionError::Integrity(BtccError::new(
            "guided_bridge_arguments_json",
            error.to_string(),
        ))
    })?;
    let raw_arguments =
        crate::json::stringify(&Value::Object(inner_arguments.clone())).map_err(|error| {
            ToolExecutionError::Integrity(BtccError::new(
                "guided_bridge_arguments_json",
                error.to_string(),
            ))
        })?;
    let inner = ModelRoundToolCall {
        id: call.id.clone(),
        name: "call_mcp_tool".into(),
        arguments: inner_arguments,
        raw_arguments,
        origin: call.origin,
    };
    let result = match Box::pin(super::super::dispatch::execute(
        owner,
        invocation,
        &inner,
        outer_call_id,
    ))
    .await
    {
        Ok(value) => value,
        Err(error) => {
            let ToolExecutionError::Integrity(ref error) = error;
            let code = error.code.as_str();
            return encoded(&underlying(id, code));
        }
    };
    attach_bridge_invocation(
        result,
        json!({"id":id,"provider":"mcp","affordance":"mcp_tool"}),
    )
}

fn attach_bridge_invocation(
    result: JsonDocument,
    meta: Value,
) -> Result<JsonDocument, ToolExecutionError> {
    let mut body = String::with_capacity(result.as_str().len() + 90);
    let source = result.as_str().trim();
    if source.starts_with('{') && source.ends_with('}') {
        body.push_str(&source[..source.len() - 1]);
        if source.len() > 2 {
            body.push(',');
        }
    } else {
        body.push_str("{\"ok\":true,\"result\":");
        body.push_str(source);
        body.push(',');
    }
    body.push_str("\"bridge_invocation\":");
    crate::json::append_json(&meta, &mut body).map_err(|error| {
        ToolExecutionError::Integrity(BtccError::new(
            "guided_bridge_result_json",
            error.to_string(),
        ))
    })?;
    body.push('}');
    JsonDocument::from_encoded(body).map_err(|error| {
        ToolExecutionError::Integrity(BtccError::new(
            "guided_bridge_result_json",
            error.to_string(),
        ))
    })
}

fn underlying(id: &str, message: &str) -> Value {
    let mut error = bridge_error("underlying_tool_error", message);
    error["error"]["id"] = Value::String(id.into());
    error["error"]["recoverable"] = Value::Bool(false);
    error["error"]["next_action"] = Value::String(
        "Treat this as an operational tool failure, not an app failure. Choose another enabled tool, adjust the request if applicable, or continue with available evidence.".into(),
    );
    error
}
