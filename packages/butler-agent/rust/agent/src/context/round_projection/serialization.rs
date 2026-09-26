use serde::Serialize;
use serde_json::{Map, Value};
use sha2::{Digest, Sha256};

use crate::btcc::{BtccError, ModelRoundMessage, ModelRoundTool, ToolChoice};

#[derive(Clone, Copy)]
pub(super) enum MessageProjection {
    Exact,
    SourceDigest,
    SummaryHistory,
}

pub(super) fn message_json(
    message: &ModelRoundMessage,
    projection: MessageProjection,
) -> Result<String, BtccError> {
    let mut output = String::new();
    append_message_json(message, projection, &mut output)?;
    Ok(output)
}

fn append_message_json(
    message: &ModelRoundMessage,
    projection: MessageProjection,
    output: &mut String,
) -> Result<(), BtccError> {
    output.push('{');
    let mut has_field = false;
    string_field(output, &mut has_field, "role", role(message.role))?;
    if message.role == crate::btcc::ModelRoundRole::Tool {
        // toolResultToMessage constructs tool fields in this order; the
        // continuation cursor appends its identity last. JSON order enters
        // source and request digests.
        optional_string_field(
            output,
            &mut has_field,
            "toolCallId",
            message.tool_call_id.as_deref(),
        )?;
        optional_string_field(output, &mut has_field, "name", message.name.as_deref())?;
        string_field(output, &mut has_field, "content", &message.content)?;
        optional_string_field(
            output,
            &mut has_field,
            "requestSegmentKind",
            message.request_segment_kind.as_deref(),
        )?;
        image_attachments_field(output, &mut has_field, &message.image_attachments)?;
        optional_string_field(
            output,
            &mut has_field,
            "operationResultCallId",
            message.operation_result_call_id.as_deref(),
        )?;
        if !matches!(projection, MessageProjection::SourceDigest)
            && let Some(reference) = &message.operation_result_reference
        {
            small_field(
                output,
                &mut has_field,
                "operationResultReference",
                reference,
            )?;
        }
        if matches!(projection, MessageProjection::Exact)
            && let Some(provider_data) = &message.provider_data
        {
            value_field(output, &mut has_field, "providerData", provider_data)?;
        }
        optional_string_field(
            output,
            &mut has_field,
            "continuationItemId",
            message.continuation_item_id.as_deref(),
        )?;
        output.push('}');
        return Ok(());
    }
    string_field(output, &mut has_field, "content", &message.content)?;
    optional_string_field(
        output,
        &mut has_field,
        "toolCallId",
        message.tool_call_id.as_deref(),
    )?;
    optional_string_field(output, &mut has_field, "name", message.name.as_deref())?;
    if let Some(calls) = &message.tool_calls {
        separator(output, &mut has_field);
        output.push_str("\"toolCalls\":[");
        for (index, call) in calls.iter().enumerate() {
            if index > 0 {
                output.push(',');
            }
            let mut call_field = false;
            output.push('{');
            string_field(output, &mut call_field, "id", &call.id)?;
            string_field(output, &mut call_field, "name", &call.name)?;
            map_field(output, &mut call_field, "arguments", &call.arguments)?;
            string_field(output, &mut call_field, "rawArguments", &call.raw_arguments)?;
            if let Some(origin) = call.origin {
                small_field(output, &mut call_field, "origin", &origin)?;
            }
            output.push('}');
        }
        output.push(']');
    }
    image_attachments_field(output, &mut has_field, &message.image_attachments)?;
    if matches!(projection, MessageProjection::Exact)
        && let Some(provider_data) = &message.provider_data
    {
        value_field(output, &mut has_field, "providerData", provider_data)?;
    }
    optional_string_field(
        output,
        &mut has_field,
        "requestSegmentKind",
        message.request_segment_kind.as_deref(),
    )?;
    if !matches!(projection, MessageProjection::SourceDigest)
        && let Some(reference) = &message.operation_result_reference
    {
        small_field(
            output,
            &mut has_field,
            "operationResultReference",
            reference,
        )?;
    }
    optional_string_field(
        output,
        &mut has_field,
        "operationResultCallId",
        message.operation_result_call_id.as_deref(),
    )?;
    optional_string_field(
        output,
        &mut has_field,
        "continuationItemId",
        message.continuation_item_id.as_deref(),
    )?;
    output.push('}');
    Ok(())
}

fn image_attachments_field(
    output: &mut String,
    has_field: &mut bool,
    attachments: &[Value],
) -> Result<(), BtccError> {
    if attachments.is_empty() {
        return Ok(());
    }
    separator(output, has_field);
    output.push_str("\"imageAttachments\":[");
    for (index, attachment) in attachments.iter().enumerate() {
        if index > 0 {
            output.push(',');
        }
        append_value(attachment, output)?;
    }
    output.push(']');
    Ok(())
}

pub(super) fn messages_json<'a>(
    messages: impl IntoIterator<Item = &'a ModelRoundMessage>,
    projection: MessageProjection,
) -> Result<String, BtccError> {
    let mut output = String::new();
    append_messages_json(messages, projection, &mut output)?;
    Ok(output)
}

fn append_messages_json<'a>(
    messages: impl IntoIterator<Item = &'a ModelRoundMessage>,
    projection: MessageProjection,
    output: &mut String,
) -> Result<(), BtccError> {
    output.push('[');
    for (index, message) in messages.into_iter().enumerate() {
        if index > 0 {
            output.push(',');
        }
        append_message_json(message, projection, output)?;
    }
    output.push(']');
    Ok(())
}

pub(super) fn units_source_json(
    messages: &[ModelRoundMessage],
    ranges: &[std::ops::Range<usize>],
) -> Result<String, BtccError> {
    let mut output = String::from("[");
    for (index, range) in ranges.iter().enumerate() {
        if index > 0 {
            output.push(',');
        }
        append_messages_json(
            messages[range.clone()].iter(),
            MessageProjection::SourceDigest,
            &mut output,
        )?;
    }
    output.push(']');
    Ok(output)
}

pub(super) fn request_json(
    instructions: Option<&str>,
    tools: &[ModelRoundTool],
    tool_choice: Option<ToolChoice>,
    messages_json: &str,
) -> Result<String, BtccError> {
    let mut output = request_prefix(instructions, tools, tool_choice)?;
    output.push_str(messages_json);
    output.push('}');
    Ok(output)
}

pub(super) fn request_for_messages(
    instructions: Option<&str>,
    tools: &[ModelRoundTool],
    tool_choice: Option<ToolChoice>,
    messages: &[ModelRoundMessage],
) -> Result<String, BtccError> {
    let mut output = request_prefix(instructions, tools, tool_choice)?;
    append_messages_json(messages.iter(), MessageProjection::Exact, &mut output)?;
    output.push('}');
    Ok(output)
}

fn request_prefix(
    instructions: Option<&str>,
    tools: &[ModelRoundTool],
    tool_choice: Option<ToolChoice>,
) -> Result<String, BtccError> {
    let mut output = String::from("{");
    let mut has_field = false;
    if let Some(instructions) = instructions {
        string_field(&mut output, &mut has_field, "instructions", instructions)?;
    }
    field(&mut output, &mut has_field, "tools", &tools)?;
    if let Some(tool_choice) = tool_choice {
        field(&mut output, &mut has_field, "toolChoice", &tool_choice)?;
    }
    if has_field {
        output.push(',');
    }
    output.push_str("\"messages\":");
    Ok(output)
}

pub(super) fn projection_digest_json(
    source_digest: &str,
    covered_units: usize,
    summary: &str,
    retained: &[Option<String>],
) -> Result<String, BtccError> {
    let mut output = String::from("{\"record\":{");
    let mut has_field = false;
    string_field(&mut output, &mut has_field, "sourceDigest", source_digest)?;
    separator(&mut output, &mut has_field);
    output.push_str("\"coveredUnits\":");
    append_value(&usize_value(covered_units)?, &mut output)?;
    string_field(&mut output, &mut has_field, "summary", summary)?;
    output.push_str("},\"retained\":[");
    for (index, item_id) in retained.iter().enumerate() {
        if index > 0 {
            output.push(',');
        }
        if let Some(item_id) = item_id {
            crate::json::write_string(item_id, &mut output).map_err(json_error)?;
        } else {
            output.push_str("null");
        }
    }
    output.push_str("]}");
    Ok(output)
}

pub(super) fn digest(value: &str) -> String {
    format!("{:x}", Sha256::digest(value.as_bytes()))
}

pub(super) fn stringify(value: &Value) -> Result<String, BtccError> {
    crate::json::stringify(value)
        .map_err(|error| BtccError::new("context_serialization_failed", error.to_string()))
}

fn field<T: Serialize + ?Sized>(
    output: &mut String,
    has_field: &mut bool,
    name: &str,
    value: &T,
) -> Result<(), BtccError> {
    if *has_field {
        output.push(',');
    }
    output.push('"');
    output.push_str(name);
    output.push_str("\":");
    let value = serde_json::to_value(value).map_err(serialization_error)?;
    output.push_str(&stringify(&value)?);
    *has_field = true;
    Ok(())
}

fn role(role: crate::btcc::ModelRoundRole) -> &'static str {
    match role {
        crate::btcc::ModelRoundRole::System => "system",
        crate::btcc::ModelRoundRole::User => "user",
        crate::btcc::ModelRoundRole::Assistant => "assistant",
        crate::btcc::ModelRoundRole::Tool => "tool",
    }
}

fn optional_string_field(
    output: &mut String,
    has_field: &mut bool,
    name: &str,
    value: Option<&str>,
) -> Result<(), BtccError> {
    if let Some(value) = value {
        string_field(output, has_field, name, value)?;
    }
    Ok(())
}

fn string_field(
    output: &mut String,
    has_field: &mut bool,
    name: &str,
    value: &str,
) -> Result<(), BtccError> {
    separator(output, has_field);
    crate::json::write_string(name, output).map_err(json_error)?;
    output.push(':');
    crate::json::write_string(value, output).map_err(json_error)
}

fn value_field(
    output: &mut String,
    has_field: &mut bool,
    name: &str,
    value: &Value,
) -> Result<(), BtccError> {
    separator(output, has_field);
    crate::json::write_string(name, output).map_err(json_error)?;
    output.push(':');
    append_value(value, output)
}

fn map_field(
    output: &mut String,
    has_field: &mut bool,
    name: &str,
    value: &Map<String, Value>,
) -> Result<(), BtccError> {
    separator(output, has_field);
    crate::json::write_string(name, output).map_err(json_error)?;
    output.push_str(":{");
    let mut entries = value.iter().collect::<Vec<_>>();
    entries.sort_by(
        |left, right| match (array_index(left.0), array_index(right.0)) {
            (Some(left), Some(right)) => left.cmp(&right),
            (Some(_), None) => std::cmp::Ordering::Less,
            (None, Some(_)) => std::cmp::Ordering::Greater,
            (None, None) => std::cmp::Ordering::Equal,
        },
    );
    for (index, (key, value)) in entries.into_iter().enumerate() {
        if index > 0 {
            output.push(',');
        }
        crate::json::write_string(key, output).map_err(json_error)?;
        output.push(':');
        append_value(value, output)?;
    }
    output.push('}');
    Ok(())
}

fn small_field<T: Serialize + ?Sized>(
    output: &mut String,
    has_field: &mut bool,
    name: &str,
    value: &T,
) -> Result<(), BtccError> {
    let value = serde_json::to_value(value).map_err(serialization_error)?;
    value_field(output, has_field, name, &value)
}

fn append_value(value: &Value, output: &mut String) -> Result<(), BtccError> {
    crate::json::append_json(value, output).map_err(json_error)
}

fn separator(output: &mut String, has_field: &mut bool) {
    if *has_field {
        output.push(',');
    }
    *has_field = true;
}

fn array_index(key: &str) -> Option<u32> {
    let value = key.parse::<u32>().ok()?;
    (value < u32::MAX && value.to_string() == key).then_some(value)
}

#[expect(
    clippy::needless_pass_by_value,
    reason = "map_err/iterator adapter taking owned values"
)]
fn json_error(error: crate::json::JsonError) -> BtccError {
    BtccError::new("context_serialization_failed", error.to_string())
}

fn usize_value(value: usize) -> Result<Value, BtccError> {
    u64::try_from(value).map(Value::from).map_err(|_| {
        BtccError::new(
            "context_compaction_record_invalid",
            "context compaction covered unit count is out of range",
        )
    })
}

#[expect(
    clippy::needless_pass_by_value,
    reason = "map_err/iterator adapter taking owned values"
)]
fn serialization_error(error: serde_json::Error) -> BtccError {
    BtccError::new("context_serialization_failed", error.to_string())
}
