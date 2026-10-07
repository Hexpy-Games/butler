//! Encode the existing source-hash payload without cloning its JSON tree.
use super::*;

pub(super) fn encode(
    value: &ConversationMessageWithParts,
    output: &mut String,
) -> ConversationResult<()> {
    let message = &value.message;
    output.clear();
    output.push_str("{\"id\":");
    string(output, &message.id)?;
    output.push_str(",\"session_id\":");
    string(output, &message.session_id)?;
    output.push_str(",\"turn_id\":");
    optional(output, message.turn_id.as_deref())?;
    output.push_str(",\"seq\":");
    json(output, &Value::from(message.seq))?;
    output.push_str(",\"role\":");
    string(output, role_text(message.role))?;
    output.push_str(",\"visibility\":");
    string(output, visibility_text(message.visibility))?;
    output.push_str(",\"provenance\":");
    string(output, provenance_text(message.provenance))?;
    output.push_str(",\"created_at\":");
    string(output, &message.created_at)?;
    output.push_str(",\"source_gateway\":");
    optional(output, message.source_gateway.as_deref())?;
    output.push_str(",\"source_ref\":");
    optional(output, message.source_ref.as_deref())?;
    output.push_str(",\"parts\":[");
    for (index, value) in value.parts.iter().enumerate() {
        if index > 0 {
            output.push(',');
        }
        part(output, value)?;
    }
    output.push_str("]}");
    Ok(())
}

fn part(output: &mut String, value: &ConversationPart) -> ConversationResult<()> {
    output.push_str("{\"id\":");
    string(output, &value.id)?;
    output.push_str(",\"part_index\":");
    json(output, &Value::from(value.part_index))?;
    output.push_str(",\"kind\":");
    string(output, part_kind_text(value.kind))?;
    output.push_str(",\"content_json\":");
    json(output, &value.content_json)?;
    output.push_str(",\"tool_call_id\":");
    optional(output, value.tool_call_id.as_deref())?;
    output.push_str(",\"parent_tool_call_id\":");
    optional(output, value.parent_tool_call_id.as_deref())?;
    output.push_str(",\"provider_shape\":");
    optional(output, value.provider_shape.map(provider_shape_text))?;
    output.push_str(",\"status\":");
    string(output, status_text(value.status))?;
    output.push('}');
    Ok(())
}

fn string(output: &mut String, value: &str) -> ConversationResult<()> {
    butler_core::json::write_string(value, output).map_err(ConversationError::json)
}

fn optional(output: &mut String, value: Option<&str>) -> ConversationResult<()> {
    match value {
        Some(value) => string(output, value),
        None => {
            output.push_str("null");
            Ok(())
        }
    }
}

fn json(output: &mut String, value: &Value) -> ConversationResult<()> {
    butler_core::json::append_json(value, output).map_err(ConversationError::json)
}
