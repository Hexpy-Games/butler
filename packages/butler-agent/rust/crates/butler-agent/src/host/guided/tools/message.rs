//! Source-shaped provider content for registered native tools.

mod preview;
pub(in crate::host) use preview::structured_raw;

use butler_core::tool_protocol::ToolName;
use butler_turn::btcc::{
    BtccError, ModelRoundMessage, ModelRoundRole, OperationResultMessageReferences, ToolResult,
    TurnRecord,
};

use super::GuidedTools;

pub(super) fn result_message(
    owner: &GuidedTools,
    turn: &TurnRecord,
    result: &ToolResult,
    references: &OperationResultMessageReferences,
) -> Result<ModelRoundMessage, BtccError> {
    if turn.turn_id != owner.binding.turn_id {
        return Err(error("guided_tool_turn_mismatch"));
    }
    // A call to a tool Butler does not provide (a model hallucination) has a
    // failed result; it goes back to the model as a tool error instead of
    // interrupting the turn (E2E TOOL-03).
    if !GuidedTools::supports(&result.name) && result.ok {
        return Err(error("guided_tool_provider_projection_unavailable"));
    }
    let mut content = String::from("{\"ok\":");
    content.push_str(if result.ok { "true" } else { "false" });
    if !result.ok
        && let Some(tool_error) = &result.error
    {
        content.push_str(",\"error\":");
        let value = serde_json::to_value(tool_error).map_err(|source| {
            error("guided_tool_provider_serialization_failed").with_source(source)
        })?;
        append_value(&mut content, &value)?;
    }
    if let Some(output) = &result.output {
        content.push_str(",\"output\":");
        append_output(result, output, &mut content)?;
    }
    content.push('}');
    let content = preview::fit(result, references, content)?;
    Ok(ModelRoundMessage {
        role: ModelRoundRole::Tool,
        content: content.into(),
        tool_call_id: Some(result.tool_call_id.clone()),
        name: Some(result.name.clone()),
        tool_calls: None,
        image_attachments: Vec::new(),
        provider_data: None,
        request_segment_kind: Some(request_segment_kind(result).into()),
        operation_result_reference: references.reference.clone(),
        operation_result_call_id: references.operation_result_call_id.clone(),
        continuation_item_id: None,
    })
}

/// Appends the provider-shaped `output` object of a tool result to `content`.
fn append_output(
    result: &ToolResult,
    output: &butler_core::json::JsonDocument,
    content: &mut String,
) -> Result<(), BtccError> {
    let encoded = output.as_str().trim();
    if encoded.starts_with('{') {
        if result.name == ToolName::ReadOperationResults
            && output
                .field("data")
                .map_err(|source| {
                    error("guided_tool_provider_serialization_failed").with_source(source)
                })?
                .is_some_and(|raw| raw.starts_with('"'))
        {
            content.push_str("{\"tool_name\":\"read_operation_results\"");
            for key in [
                "encoding",
                "data",
                "offset",
                "length",
                "totalBytes",
                "nextOffset",
                "resultSha256",
                "complete",
            ] {
                if let Some(value) = output.field(key).map_err(|source| {
                    error("guided_tool_provider_serialization_failed").with_source(source)
                })? {
                    content.push(',');
                    butler_core::json::write_string(key, content).map_err(|source| {
                        error("guided_tool_provider_serialization_failed").with_source(source)
                    })?;
                    content.push(':');
                    content.push_str(value);
                }
            }
            content.push('}');
        } else {
            content.push_str("{\"tool_name\":");
            butler_core::json::write_string(&result.name, content).map_err(|source| {
                error("guided_tool_provider_serialization_failed").with_source(source)
            })?;
            if encoded.len() > 2 {
                content.push(',');
                content.push_str(&encoded[1..encoded.len() - 1]);
            }
            content.push('}');
        }
    } else if encoded.starts_with('"') {
        content.push_str("{\"tool_name\":");
        butler_core::json::write_string(&result.name, content).map_err(|source| {
            error("guided_tool_provider_serialization_failed").with_source(source)
        })?;
        content.push_str(",\"text\":");
        content.push_str(encoded);
        content.push('}');
    } else {
        content.push_str("{\"tool_name\":");
        butler_core::json::write_string(&result.name, content).map_err(|source| {
            error("guided_tool_provider_serialization_failed").with_source(source)
        })?;
        content.push_str(",\"value\":");
        content.push_str(encoded);
        content.push('}');
    }
    Ok(())
}

/// The request segment a tool result message belongs to.
fn request_segment_kind(result: &ToolResult) -> &'static str {
    match result.name.as_str() {
        "read_operation_results" => "exact_result_view",
        "query_memory" | "recall_memory" => "memory_recall_context",
        name if !result.ok && crate::host::GuidedWorkTools::is_work_tool(name) => {
            "work_recovery_receipt"
        }
        _ => "latest_tool_result_delivery",
    }
}

fn error(code: &'static str) -> BtccError {
    BtccError::relayed(code, code)
}

fn append_value(output: &mut String, value: &serde_json::Value) -> Result<(), BtccError> {
    butler_core::json::append_json(value, output)
        .map_err(|source| error("guided_tool_provider_serialization_failed").with_source(source))
}

/// Fixed recovery text survives the native dispatcher's error sanitization.
pub(super) fn tool_failure(name: &str, code: &str) -> serde_json::Value {
    if name == "recall_memory" && code == "stale_detail_handle" {
        return serde_json::json!({"ok":false,"error":{
            "code":"stale_detail_handle",
            "message":"Generation/revision changed or handle expired; call recall_memory again."
        }});
    }
    serde_json::json!({"ok":false,"error":{
        "code":"tool_error", "message":format!("{name} could not complete: {code}")
    }})
}
