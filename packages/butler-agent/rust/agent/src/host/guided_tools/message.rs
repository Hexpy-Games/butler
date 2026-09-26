//! Source-shaped provider content for registered native tools.

mod preview;
pub(in crate::host) use preview::structured_raw;

use crate::btcc::{
    BtccError, ModelRoundMessage, ModelRoundRole, OperationResultMessageReferences, ToolResult,
    TurnRecord,
};

use super::NativeGuidedTools;

pub(super) fn result_message(
    owner: &NativeGuidedTools,
    turn: &TurnRecord,
    result: &ToolResult,
    references: &OperationResultMessageReferences,
) -> Result<ModelRoundMessage, BtccError> {
    if turn.turn_id != owner.binding.turn_id {
        return Err(error("guided_tool_turn_mismatch"));
    }
    if !NativeGuidedTools::supports(&result.name) {
        return Err(error("guided_tool_provider_projection_unavailable"));
    }
    let mut content = String::from("{\"ok\":");
    content.push_str(if result.ok { "true" } else { "false" });
    if !result.ok
        && let Some(tool_error) = &result.error
    {
        content.push_str(",\"error\":");
        let value = serde_json::to_value(tool_error)
            .map_err(|_| error("guided_tool_provider_serialization_failed"))?;
        append_value(&mut content, &value)?;
    }
    if let Some(output) = &result.output {
        content.push_str(",\"output\":");
        let encoded = output.as_str().trim();
        if encoded.starts_with('{') {
            if result.name == "read_operation_results"
                && output
                    .field("data")
                    .map_err(|_| error("guided_tool_provider_serialization_failed"))?
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
                    if let Some(value) = output
                        .field(key)
                        .map_err(|_| error("guided_tool_provider_serialization_failed"))?
                    {
                        content.push(',');
                        crate::json::write_string(key, &mut content)
                            .map_err(|_| error("guided_tool_provider_serialization_failed"))?;
                        content.push(':');
                        content.push_str(value);
                    }
                }
                content.push('}');
            } else {
                content.push_str("{\"tool_name\":");
                crate::json::write_string(&result.name, &mut content)
                    .map_err(|_| error("guided_tool_provider_serialization_failed"))?;
                if encoded.len() > 2 {
                    content.push(',');
                    content.push_str(&encoded[1..encoded.len() - 1]);
                }
                content.push('}');
            }
        } else if encoded.starts_with('"') {
            content.push_str("{\"tool_name\":");
            crate::json::write_string(&result.name, &mut content)
                .map_err(|_| error("guided_tool_provider_serialization_failed"))?;
            content.push_str(",\"text\":");
            content.push_str(encoded);
            content.push('}');
        } else {
            content.push_str("{\"tool_name\":");
            crate::json::write_string(&result.name, &mut content)
                .map_err(|_| error("guided_tool_provider_serialization_failed"))?;
            content.push_str(",\"value\":");
            content.push_str(encoded);
            content.push('}');
        }
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
        request_segment_kind: Some(
            match result.name.as_str() {
                "read_operation_results" => "exact_result_view",
                "query_memory" | "recall_memory" => "memory_recall_context",
                name if !result.ok && crate::host::NativeGuidedWorkTools::is_work_tool(name) => {
                    "work_recovery_receipt"
                }
                _ => "latest_tool_result_delivery",
            }
            .into(),
        ),
        operation_result_reference: references.reference.clone(),
        operation_result_call_id: references.operation_result_call_id.clone(),
        continuation_item_id: None,
    })
}

fn error(code: &'static str) -> BtccError {
    BtccError::new(code, code)
}

fn append_value(output: &mut String, value: &serde_json::Value) -> Result<(), BtccError> {
    crate::json::append_json(value, output)
        .map_err(|_| error("guided_tool_provider_serialization_failed"))
}
