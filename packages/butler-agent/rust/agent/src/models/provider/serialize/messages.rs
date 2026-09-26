use serde_json::{Map, Value};

use crate::btcc::{ModelRoundMessage, ModelRoundRequest, ModelRoundRole};

pub(super) fn bounded_items(messages: &[ModelRoundMessage]) -> Vec<Value> {
    messages
        .iter()
        .flat_map(|message| match message.role {
            ModelRoundRole::User => vec![serde_json::json!({"role":"user","content":[{"type":"input_text","text":message.content}]})],
            ModelRoundRole::Tool => vec![serde_json::json!({"type":"function_call_output","call_id":message.tool_call_id,"output":message.content})],
            ModelRoundRole::Assistant => {
                let mut items = if message.content.is_empty() { Vec::new() } else { vec![serde_json::json!({"role":"assistant","content":[{"type":"output_text","text":message.content}]})] };
                items.extend(message.tool_calls.as_deref().unwrap_or(&[]).iter().map(|call| serde_json::json!({"type":"function_call","call_id":call.id,"name":call.name,"arguments":call.raw_arguments})));
                items
            }
            ModelRoundRole::System => Vec::new(),
        })
        .collect()
}

pub(super) fn bounded_items_with_ordinals(
    messages: &[ModelRoundMessage],
) -> Result<(Vec<Value>, Vec<u64>), &'static str> {
    let mut items = Vec::new();
    let mut ordinals = Vec::new();
    for message in messages {
        if message.role == ModelRoundRole::System {
            continue;
        }
        let ordinal = turn_item_ordinal(message.continuation_item_id.as_deref())?;
        let projected = bounded_items(std::slice::from_ref(message));
        ordinals.extend(std::iter::repeat_n(ordinal, projected.len()));
        items.extend(projected);
    }
    Ok((items, ordinals))
}

pub(super) fn turn_item_ordinal(value: Option<&str>) -> Result<u64, &'static str> {
    let value = value
        .and_then(|value| value.strip_prefix("turn-item-"))
        .ok_or("bounded_continuation_turn_item_identity_missing")?;
    if value.is_empty()
        || value.len() > 7
        || (value.len() > 1 && value.starts_with('0'))
        || !value.bytes().all(|byte| byte.is_ascii_digit())
    {
        return Err("bounded_continuation_turn_item_identity_missing");
    }
    value
        .parse::<u64>()
        .ok()
        .filter(|value| *value <= 1_000_000)
        .ok_or("bounded_continuation_turn_item_identity_missing")
}
pub(super) fn chat_messages(request: &ModelRoundRequest<'_>) -> Vec<Value> {
    chat_messages_with_instructions(request, request.instructions)
}

pub(super) fn local_chat_messages(request: &ModelRoundRequest<'_>) -> Vec<Value> {
    let instructions = if request.tools.is_empty() {
        request.instructions.map(str::to_owned)
    } else {
        Some(
            [
                request
                    .instructions
                    .map(crate::public_text::trim_js_whitespace)
                    .filter(|value| !value.is_empty()),
                Some("When a request depends on current, external, public, or user-environment state, choose and call the appropriate tool from the provided tool catalog before answering. Do not ask the user to name the tool."),
                Some("When a tool is needed, use only the structured tool-call channel provided by the API (`message.tool_calls`) or an explicit backend-native `<|tool_call>...<tool_call|>` marker. Do not write pseudo tool calls, raw function-call syntax, Markdown code, JSON tool calls, or process notes as a substitute for a tool call. If you cannot call a tool, answer directly and say what cannot be verified."),
                Some("For local config, manifest, script, or log inspection, prefer a focused command that returns only the requested fields. Do not dump a whole file when a case-insensitive search or structured extraction can answer the question."),
            ]
            .into_iter()
            .flatten()
            .collect::<Vec<_>>()
            .join("\n\n"),
        )
    };
    chat_messages_with_instructions(request, instructions.as_deref())
}

fn chat_messages_with_instructions(
    request: &ModelRoundRequest<'_>,
    instructions: Option<&str>,
) -> Vec<Value> {
    let mut output = Vec::new();
    if let Some(value) = instructions
        .map(crate::public_text::trim_js_whitespace)
        .filter(|value| !value.is_empty())
    {
        output.push(serde_json::json!({"role":"system","content":value}));
    }
    for message in request.messages {
        let role = role(message.role);
        let mut row = Map::new();
        row.insert("role".into(), role.into());
        row.insert(
            "content".into(),
            if message.role == ModelRoundRole::Assistant && message.content.is_empty() {
                Value::Null
            } else {
                message.content.as_ref().to_owned().into()
            },
        );
        if let Some(id) = &message.tool_call_id {
            row.insert("tool_call_id".into(), id.clone().into());
        }
        if let Some(name) = &message.name {
            row.insert("name".into(), name.clone().into());
        }
        if let Some(calls) = message
            .tool_calls
            .as_ref()
            .filter(|calls| !calls.is_empty())
        {
            row.insert("tool_calls".into(), Value::Array(calls.iter().map(|call| serde_json::json!({"id":call.id,"type":"function","function":{"name":call.name,"arguments":call.raw_arguments}})).collect()));
        }
        output.push(row.into());
    }
    output
}

pub(super) fn response_items(request: &ModelRoundRequest<'_>) -> Vec<Value> {
    request.messages.iter().flat_map(|message| match message.role {
        ModelRoundRole::System => Vec::new(),
        ModelRoundRole::Tool => vec![serde_json::json!({"type":"function_call_output","call_id":message.tool_call_id,"output":message.content})],
        ModelRoundRole::Assistant => response_assistant_items(message),
        ModelRoundRole::User => vec![serde_json::json!({"role":"user","content":message.content})],
    }).collect()
}

fn response_assistant_items(message: &ModelRoundMessage) -> Vec<Value> {
    let mut items = match message.provider_data.as_ref() {
        Some(Value::Array(values)) => values
            .iter()
            .filter(|value| value.is_object())
            .cloned()
            .collect(),
        Some(value) if value.is_object() => vec![value.clone()],
        _ => Vec::new(),
    };
    let provider_call_ids = items
        .iter()
        .filter(|item| item.get("type").and_then(Value::as_str) == Some("function_call"))
        .filter_map(|item| item.get("call_id").and_then(Value::as_str))
        .map(str::to_owned)
        .collect::<std::collections::HashSet<_>>();
    items.extend(
        message
            .tool_calls
            .as_deref()
            .unwrap_or(&[])
            .iter()
            .filter(|call| !provider_call_ids.contains(call.id.as_str()))
            .map(|call| serde_json::json!({"type":"function_call","call_id":call.id,"name":call.name,"arguments":call.raw_arguments})),
    );
    if items.is_empty() && !message.content.is_empty() {
        items.push(serde_json::json!({"role":"assistant","content":[{"type":"output_text","text":message.content}]}));
    }
    items
}

pub(super) fn anthropic_messages(request: &ModelRoundRequest<'_>) -> Vec<Value> {
    request.messages.iter().filter_map(|message| match message.role {
        ModelRoundRole::System => None,
        ModelRoundRole::Assistant => Some(serde_json::json!({"role":"assistant","content": if let Some(value)=&message.provider_data { value.clone() } else { Value::Array(assistant_blocks(message)) }})),
        ModelRoundRole::Tool => Some(serde_json::json!({"role":"user","content":[{"type":"tool_result","tool_use_id":message.tool_call_id,"content":message.content}]})),
        ModelRoundRole::User => Some(serde_json::json!({"role":"user","content":message.content})),
    }).collect()
}

fn assistant_blocks(message: &ModelRoundMessage) -> Vec<Value> {
    let mut blocks = Vec::new();
    if !message.content.is_empty() {
        blocks.push(serde_json::json!({"type":"text","text":message.content}));
    }
    blocks.extend(message.tool_calls.as_deref().unwrap_or(&[]).iter().map(|call| serde_json::json!({"type":"tool_use","id":call.id,"name":call.name,"input":call.arguments})));
    blocks
}

pub(super) fn gemini_messages(request: &ModelRoundRequest<'_>) -> Vec<Value> {
    request.messages.iter().filter_map(|message| match message.role {
        ModelRoundRole::System => None,
        ModelRoundRole::Assistant => Some(serde_json::json!({"role":"model","parts":message.provider_data.clone().filter(Value::is_array).unwrap_or_else(|| Value::Array(gemini_assistant_parts(message)))})),
        ModelRoundRole::Tool => Some(serde_json::json!({"role":"user","parts":[{"functionResponse":{"name":message.name.as_deref().unwrap_or("unknown_tool"),"response":parse_object(&message.content)}}]})),
        ModelRoundRole::User => Some(serde_json::json!({"role":"user","parts":[{"text":message.content}]})),
    }).collect()
}

fn gemini_assistant_parts(message: &ModelRoundMessage) -> Vec<Value> {
    let mut parts = Vec::new();
    if !message.content.is_empty() {
        parts.push(serde_json::json!({"text":message.content}));
    }
    parts.extend(
        message.tool_calls.as_deref().unwrap_or(&[]).iter().map(
            |call| serde_json::json!({"functionCall":{"name":call.name,"args":call.arguments}}),
        ),
    );
    parts
}

fn parse_object(value: &str) -> Value {
    serde_json::from_str(value).unwrap_or_else(|_| serde_json::json!({"output":value}))
}
fn role(value: ModelRoundRole) -> &'static str {
    match value {
        ModelRoundRole::System => "system",
        ModelRoundRole::User => "user",
        ModelRoundRole::Assistant => "assistant",
        ModelRoundRole::Tool => "tool",
    }
}
