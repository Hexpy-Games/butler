use serde_json::{Map, Value, json};

use crate::btcc::{ModelRoundError, ModelRoundRequest, ModelRoundResult, RuntimeFailure};

#[derive(Clone)]
pub(super) struct RequestSnapshot {
    pub(super) model: String,
    pub(super) round_id: Option<String>,
    pub(super) reasoning_effort: Value,
    pub(super) sections: Vec<Value>,
}

#[derive(Clone)]
pub(super) struct ResponseSnapshot {
    pub(super) raw: Value,
    pub(super) provider_raw: bool,
}

#[derive(Clone)]
pub(super) struct FailureSnapshot {
    pub(super) code: String,
    pub(super) message: String,
    pub(super) retryable: bool,
    pub(super) failure: Value,
    pub(super) diagnostics: Value,
}

pub(super) fn request_snapshot(request: &ModelRoundRequest<'_>) -> Option<RequestSnapshot> {
    let mut sections = Vec::new();
    if let Some(instructions) = request.instructions.filter(|value| !value.is_empty()) {
        sections.push(section("instructions", "instructions", instructions));
    }
    for (index, message) in request.messages.iter().enumerate() {
        let role = serde_json::to_value(message.role)
            .ok()?
            .as_str()?
            .to_owned();
        let title = message
            .request_segment_kind
            .as_deref()
            .map(|kind| format!("{role} · {kind}"))
            .unwrap_or_else(|| role.clone());
        let mut value = Map::new();
        value.insert("role".into(), Value::String(role));
        value.insert("content".into(), Value::String(message.content.to_string()));
        insert_optional(&mut value, "name", message.name.as_ref());
        insert_optional(&mut value, "toolCallId", message.tool_call_id.as_ref());
        if let Some(calls) = &message.tool_calls {
            value.insert("toolCalls".into(), serde_json::to_value(calls).ok()?);
        }
        let content = serde_json::to_string(&Value::Object(value)).ok()?;
        sections.push(section(&format!("message-{index}"), &title, &content));
    }
    sections.push(section(
        "tools",
        "tools",
        &serde_json::to_string(request.tools).ok()?,
    ));
    Some(RequestSnapshot {
        model: request.model.to_owned(),
        round_id: request.round_id.map(str::to_owned),
        reasoning_effort: serde_json::to_value(request.reasoning_effort).ok()?,
        sections,
    })
}

fn section(id: &str, title: &str, content: &str) -> Value {
    json!({
        "id": id,
        "title": title,
        "region": "unknown",
        "char_count": utf16_len(content),
        "content": content,
    })
}

fn insert_optional(map: &mut Map<String, Value>, name: &str, value: Option<&String>) {
    if let Some(value) = value {
        map.insert(name.to_owned(), Value::String(value.clone()));
    }
}

pub(super) fn response_snapshot(response: &ModelRoundResult) -> ResponseSnapshot {
    let provider_raw = response.raw.is_some();
    let raw = response
        .raw
        .as_ref()
        .filter(|value| !value.is_null())
        .cloned()
        .unwrap_or_else(|| {
            let mut raw = Map::new();
            insert_optional(&mut raw, "text", response.text.as_ref());
            raw.insert(
                "toolCalls".into(),
                serde_json::to_value(&response.tool_calls).unwrap_or(Value::Null),
            );
            insert_optional_value(&mut raw, "usage", response.usage.as_ref());
            if let Some(identity) = &response.provider_identity
                && let Ok(identity) = serde_json::to_value(identity)
            {
                raw.insert("providerIdentity".into(), identity);
            }
            Value::Object(raw)
        });
    ResponseSnapshot { raw, provider_raw }
}

fn insert_optional_value(map: &mut Map<String, Value>, name: &str, value: Option<&Value>) {
    if let Some(value) = value {
        map.insert(name.to_owned(), value.clone());
    }
}

pub(super) fn failure_snapshot(error: &ModelRoundError) -> FailureSnapshot {
    let (code, message, retryable, failure) = match error {
        ModelRoundError::Provider(value) => (
            value.code.clone(),
            value.message.clone(),
            value.retryable,
            serde_json::to_value(value.as_ref()).unwrap_or(Value::Null),
        ),
        ModelRoundError::RequestAdmission(value) => (
            serde_json::to_value(value.code)
                .ok()
                .and_then(|value| value.as_str().map(str::to_owned))
                .unwrap_or_else(|| "model_request_admission_failed".into()),
            value.message.clone(),
            false,
            json!({"code": value.code, "message": value.message, "retryable": false}),
        ),
        ModelRoundError::InvocationFailure { code, message } => (
            code.clone().unwrap_or_else(|| "gateway_failed".into()),
            message.clone(),
            true,
            json!({"code": code, "message": message, "retryable": true}),
        ),
        ModelRoundError::StablePrefix(message) => (
            "provider_unknown_error".into(),
            message.clone(),
            true,
            json!({"code": "provider_unknown_error", "message": message, "retryable": true}),
        ),
        ModelRoundError::ImageAdmission { code, reason } => (
            code.clone(),
            reason.clone(),
            false,
            json!({"code": code, "message": reason, "retryable": false}),
        ),
        ModelRoundError::Recovered {
            failure_code,
            disposition,
        } => (
            failure_code.clone(),
            "Recovered model failure remained terminal for this turn.".into(),
            disposition == "retry",
            json!({"code": failure_code, "disposition": disposition, "retryable": disposition == "retry"}),
        ),
        ModelRoundError::DispatchLimit => (
            "model_route_dispatch_limit_exceeded".into(),
            "The model route exceeded its dispatch limit.".into(),
            true,
            json!({"code": "model_route_dispatch_limit_exceeded", "retryable": true}),
        ),
        ModelRoundError::Cancelled => (
            "turn_cancelled".into(),
            "The turn was cancelled.".into(),
            false,
            json!({"code": "turn_cancelled", "retryable": false}),
        ),
        ModelRoundError::Operational(value) => runtime_failure(value),
        ModelRoundError::Integrity(value) => (
            value.code().to_owned(),
            value.message().to_owned(),
            true,
            json!({"code": value.code(), "message": value.message(), "retryable": true}),
        ),
    };
    let diagnostics = diagnostic_details(&failure, &code, retryable);
    FailureSnapshot {
        code,
        message,
        retryable,
        failure,
        diagnostics,
    }
}

fn runtime_failure(value: &RuntimeFailure) -> (String, String, bool, Value) {
    (
        value.code.clone(),
        "Butler could not complete this turn.".into(),
        value.retryable,
        json!({"code": value.code, "message": "Butler could not complete this turn.", "retryable": value.retryable}),
    )
}

pub(super) fn diagnostic_details(failure: &Value, code: &str, retryable: bool) -> Value {
    let mut details = Map::new();
    details.insert("code".into(), Value::String(code.to_owned()));
    details.insert("retryable".into(), Value::Bool(retryable));
    for key in [
        "provider",
        "api",
        "statusCode",
        "endpoint",
        "model",
        "cause",
        "providerErrorCode",
        "providerErrorType",
        "providerErrorDetails",
    ] {
        if let Some(value) = failure
            .get(key)
            .filter(|value| !value.is_null() && !value.as_str().is_some_and(str::is_empty))
        {
            details.insert(camel_to_snake(key), value.clone());
        }
    }
    Value::Object(details)
}

fn camel_to_snake(value: &str) -> String {
    let mut output = String::with_capacity(value.len() + 4);
    for character in value.chars() {
        if character.is_ascii_uppercase() {
            output.push('_');
            output.push(character.to_ascii_lowercase());
        } else {
            output.push(character);
        }
    }
    output
}

pub(super) fn utf16_len(value: &str) -> usize {
    value.encode_utf16().count()
}
