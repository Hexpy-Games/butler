//! Stateful and stateless Responses input, validating bounded identities once.
use super::super::output_image;
use super::*;

pub(super) fn response_input(
    request: &ModelRoundRequest<'_>,
    config: &ProviderRequestConfig,
    continuation: Option<&mut continuation::LegacyPreparation>,
) -> Result<Value, butler_turn::btcc::ModelRoundError> {
    if config.metadata.provider_id != "openai" {
        return Ok(Value::Array(messages::response_items(request)));
    }
    let stateless = matches!(
        config.auth.mode(),
        ProviderAuthMode::CodexOauth | ProviderAuthMode::CodexSubscription
    );
    // Codex sends the complete stateless history. Do not construct and discard
    // a second projection of that same history for a stateful request first.
    if let Some(continuation) = continuation {
        return Ok(if stateless {
            Value::Array(continuation.successful.stateless_request_input.clone())
        } else {
            std::mem::take(&mut continuation.request_items)
        });
    }
    openai_input(request, stateless)
}

fn openai_input(
    request: &ModelRoundRequest<'_>,
    stateless: bool,
) -> Result<Value, butler_turn::btcc::ModelRoundError> {
    if let Some(bounded) = request.bounded_continuation {
        return bounded_input(request, bounded, stateless);
    }
    if stateless {
        return Ok(Value::Array(messages::bounded_items(request.messages)));
    }
    if let Some(previous) = request.continuation
        && continuation::is_openai(previous)
    {
        let sent_tools = previous
            .pointer("/sent/toolMessages")
            .and_then(Value::as_u64)
            .unwrap_or(0);
        let sent_users = previous
            .pointer("/sent/userMessages")
            .and_then(Value::as_u64)
            .unwrap_or(0);
        let mut tools = 0;
        let mut users = 0;
        let items = request.messages.iter().filter_map(|message| match message.role {
            ModelRoundRole::Tool => {
                tools += 1;
                (tools > sent_tools).then(|| serde_json::json!({"type":"function_call_output","call_id":message.tool_call_id,"output":output_image::response_output(message)}))
            }
            ModelRoundRole::User => {
                users += 1;
                (users > sent_users).then(|| serde_json::json!({"role":"user","content":[{"type":"input_text","text":message.content}]}))
            }
            _ => None,
        }).collect();
        return Ok(Value::Array(items));
    }
    Ok(request
        .messages
        .iter()
        .find(|message| message.role == ModelRoundRole::User)
        .map(|message| Value::String(message.content.as_ref().to_owned()))
        .unwrap_or(Value::String(String::new())))
}

fn bounded_input(
    request: &ModelRoundRequest<'_>,
    bounded: &Value,
    stateless: bool,
) -> Result<Value, butler_turn::btcc::ModelRoundError> {
    let response = bounded
        .get("responseItemId")
        .and_then(Value::as_str)
        .and_then(|value| messages::turn_item_ordinal(Some(value)))
        .ok_or_else(|| continuation_error("bounded_continuation_turn_item_identity_missing"))?;
    let previous = request
        .continuation
        .filter(|value| continuation::is_openai(value));
    if previous.is_some_and(|value| value.get("deliveredThroughOrdinal").is_none()) {
        return Err(continuation_error("bounded_continuation_watermark_missing"));
    }
    let delivered = previous
        .map(|value| {
            value
                .get("deliveredThroughOrdinal")
                .and_then(Value::as_u64)
                .filter(|value| *value <= 1_000_000)
                .ok_or_else(|| continuation_error("bounded_continuation_watermark_invalid"))
        })
        .transpose()?
        .map_or(-1_i64, |value| i64::try_from(value).unwrap_or(i64::MAX));
    let (items, ordinals) = messages::bounded_items_with_ordinals(request.messages)
        .ok_or_else(|| continuation_error("bounded_continuation_turn_item_identity_missing"))?;
    if i64::try_from(response).unwrap_or(i64::MAX) <= delivered
        || ordinals.iter().any(|value| *value >= response)
        || ordinals.windows(2).any(|pair| pair[1] < pair[0])
    {
        return Err(continuation_error(
            "bounded_continuation_item_identity_invalid",
        ));
    }
    if stateless {
        return Ok(Value::Array(items));
    }
    Ok(Value::Array(
        items
            .into_iter()
            .zip(ordinals)
            .filter_map(|(item, ordinal)| {
                (i64::try_from(ordinal).unwrap_or(i64::MAX) > delivered).then_some(item)
            })
            .collect(),
    ))
}

fn continuation_error(code: &'static str) -> butler_turn::btcc::ModelRoundError {
    butler_turn::btcc::ModelRoundError::Integrity(butler_turn::btcc::BtccError::relayed(code, code))
}
