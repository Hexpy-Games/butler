use serde_json::Value;

use crate::btcc::{ModelRoundMessage, ModelRoundRequest, ModelRoundRole};

pub(super) struct LegacyPreparation {
    pub request_items: Value,
    pub successful: LegacyProjection,
}

pub(super) struct LegacyProjection {
    pub stateless_request_input: Vec<Value>,
    pub sent_tools: u64,
    pub sent_users: u64,
}

pub(super) fn prepare(
    request: &ModelRoundRequest<'_>,
) -> Result<Option<LegacyPreparation>, crate::btcc::ModelRoundError> {
    if request.bounded_continuation.is_some() {
        return Ok(None);
    }
    let Some(previous) = request.continuation.filter(|value| is_openai(value)) else {
        return Ok(None);
    };
    let already_sent_tools = sent(previous, "toolMessages")?;
    let already_sent_users = sent(previous, "userMessages")?;
    let prior = previous
        .get("statelessInput")
        .and_then(Value::as_array)
        .ok_or_else(|| invalid("openai_stateless_continuation_missing"))?;
    let mut stateless_request_input = project_acknowledged(prior, request.messages);
    let mut request_items = Vec::new();
    let mut tools = 0_u64;
    let mut users = 0_u64;
    for message in request.messages {
        let item = match message.role {
            ModelRoundRole::Tool => {
                tools += 1;
                ((tools as i64) > already_sent_tools).then(|| {
                    serde_json::json!({"type":"function_call_output","call_id":message.tool_call_id,"output":message.content})
                })
            }
            ModelRoundRole::User => {
                users += 1;
                ((users as i64) > already_sent_users).then(|| {
                    serde_json::json!({"role":"user","content":[{"type":"input_text","text":message.content}]})
                })
            }
            _ => None,
        };
        if let Some(item) = item {
            stateless_request_input.push(item.clone());
            request_items.push(item);
        }
    }
    Ok(Some(LegacyPreparation {
        request_items: Value::Array(request_items),
        successful: LegacyProjection {
            stateless_request_input,
            sent_tools: tools,
            sent_users: users,
        },
    }))
}

fn sent(previous: &Value, field: &str) -> Result<i64, crate::btcc::ModelRoundError> {
    previous
        .pointer(&format!("/sent/{field}"))
        .and_then(Value::as_f64)
        .filter(|value| value.fract() == 0.0 && value.abs() <= 9_007_199_254_740_991.0)
        .map(|value| value as i64)
        .ok_or_else(|| invalid("openai_sent_continuation_missing"))
}

pub(super) fn is_openai(value: &Value) -> bool {
    value.get("provider").and_then(Value::as_str) == Some("openai")
        && value.get("responseId").and_then(Value::as_str).is_some()
}

fn project_acknowledged(previous: &[Value], messages: &[ModelRoundMessage]) -> Vec<Value> {
    previous
        .iter()
        .map(|item| {
            let call_id = item
                .get("type")
                .and_then(Value::as_str)
                .filter(|value| *value == "function_call_output")
                .and_then(|_| item.get("call_id"))
                .and_then(Value::as_str);
            let Some(message) = call_id.filter(|id| !id.is_empty()).and_then(|id| {
                messages.iter().rev().find(|message| {
                    message.role == ModelRoundRole::Tool
                        && message.tool_call_id.as_deref() == Some(id)
                        && message.operation_result_reference.is_some()
                })
            }) else {
                return item.clone();
            };
            let mut projected = item.clone();
            if let Some(object) = projected.as_object_mut() {
                object.insert("output".into(), message.content.as_ref().to_owned().into());
            }
            projected
        })
        .collect()
}

pub(super) fn successful(projection: LegacyProjection, response: &Value) -> (Vec<Value>, u64, u64) {
    let mut items = projection.stateless_request_input;
    if let Some(output) = response.get("output").and_then(Value::as_array) {
        items.extend(
            output
                .iter()
                .filter(|item| item.get("type").and_then(Value::as_str) == Some("function_call"))
                .cloned(),
        );
    }
    for item in &mut items {
        if item.get("type").and_then(Value::as_str) != Some("function_call_output") {
            continue;
        }
        let Some(output) = item.get_mut("output").and_then(Value::as_array_mut) else {
            continue;
        };
        output.retain(|part| part.get("type").and_then(Value::as_str) != Some("input_image"));
    }
    (items, projection.sent_tools, projection.sent_users)
}

fn invalid(code: &'static str) -> crate::btcc::ModelRoundError {
    crate::btcc::ModelRoundError::Integrity(crate::btcc::BtccError::new(code, code))
}
