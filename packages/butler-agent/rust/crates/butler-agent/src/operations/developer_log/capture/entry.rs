use chrono::{SecondsFormat, Utc};
use serde_json::{Map, Value, json};

use crate::btcc::{AgentLoopError, AgentLoopResult, RuntimeFailure, TurnRecord};

use super::super::redaction;
use super::CaptureState;
use super::snapshot::{FailureSnapshot, ResponseSnapshot, diagnostic_details, utf16_len};

pub(super) fn terminal_entry(
    turn: &TurnRecord,
    result: Result<&AgentLoopResult, &AgentLoopError>,
    state: &CaptureState,
) -> Option<Value> {
    let timestamp = Utc::now().to_rfc3339_opts(SecondsFormat::Millis, true);
    let request = state.request.as_ref();
    let response = state.response.as_ref();
    let sections = request
        .map(|request| {
            request
                .sections
                .iter()
                .map(redact_section)
                .collect::<Vec<_>>()
        })
        .unwrap_or_default();
    let prompt_context = sections
        .iter()
        .map(|section| {
            format!(
                "[{}]\n{}",
                section
                    .get("title")
                    .and_then(Value::as_str)
                    .unwrap_or_default(),
                section
                    .get("content")
                    .and_then(Value::as_str)
                    .unwrap_or_default()
            )
        })
        .collect::<Vec<_>>()
        .join("\n\n");
    let (kind, response_text, failure) = match result {
        Ok(value) if value.runtime_failure.is_none() => ("model_turn", value.content.clone(), None),
        Ok(value) => {
            let failure = state
                .failure
                .clone()
                .unwrap_or_else(|| failure_from_runtime(value.runtime_failure.as_ref()));
            ("model_turn_error", failure.message.clone(), Some(failure))
        }
        Err(error) => {
            let failure = state
                .failure
                .clone()
                .unwrap_or_else(|| failure_from_loop_error(error));
            ("model_turn_error", failure.message.clone(), Some(failure))
        }
    };
    let model_selection = &turn.model_selection;
    let provider = model_selection
        .get("provider")
        .and_then(Value::as_str)
        .unwrap_or_default();
    let model_name = model_selection
        .get("model")
        .and_then(Value::as_str)
        .unwrap_or_default();
    let model_ref = format!("{provider}/{model_name}");
    let policy = turn.context.get("executionPolicy");
    let role = match policy
        .and_then(|value| value.get("role"))
        .and_then(Value::as_str)
    {
        Some("steward") => "steward",
        Some("worker") => "worker",
        _ => "butler",
    };
    let destination = turn.progress_destination.as_ref();
    let raw = response_raw(response);
    let mut metadata = Map::new();
    metadata.insert(
        "capture_scope".into(),
        Value::String("last_provider_round".into()),
    );
    metadata.insert(
        "provider_round_count".into(),
        Value::Number(state.round_count.into()),
    );
    metadata.insert(
        "effective_model_ref".into(),
        request.map_or(Value::Null, |value| Value::String(value.model.clone())),
    );
    metadata.insert(
        "round_id".into(),
        request
            .and_then(|value| value.round_id.clone())
            .map_or(Value::Null, Value::String),
    );
    metadata.insert("request_available".into(), Value::Bool(request.is_some()));
    metadata.insert(
        "response_format".into(),
        Value::String(
            match response {
                None => "unavailable",
                Some(value) if value.provider_raw => "provider_raw",
                Some(_) => "normalized",
            }
            .into(),
        ),
    );
    if let Some(request) = request {
        metadata.insert("reasoning_effort".into(), request.reasoning_effort.clone());
    }
    let mut entry = json!({
        "schema": "butler.developer-log.v1",
        "id": format!("devlog-{}", uuid::Uuid::new_v4()),
        "kind": kind,
        "created_at": timestamp,
        "session_id": turn.session_id,
        "turn_id": nonempty(&turn.turn_id),
        "role": role,
        "transport": destination.map_or("unrouted", |value| value.transport.as_str()),
        "route": {
            "session_id": Value::Null,
            "role": Value::Null,
            "reason": Value::Null,
            "project_id": Value::Null,
        },
        "model": {
            "requested_model_ref": model_ref,
            "provider_id": if provider.is_empty() { Value::Null } else { Value::String(provider.to_owned()) },
            "runtime_adapter_id": "btcc-turn-runtime",
        },
        "context": {
            "live_config_hash": Value::Null,
            "region_order": ["static_context", "live_configuration", "runtime_state", "working_context", "retrieved_context", "current_input"],
            "sections": sections,
            "references": [],
            "prompt_context": prompt_context,
        },
        "request": {
            "input_text": turn.original_message.trim(),
            "metadata": metadata,
        },
        "response": {"text": response_text, "raw": raw},
        "privacy": {"raw_text_included": true, "secrets_redacted": true, "local_only": true},
    });
    if let Some(failure) = failure {
        let mut diagnostics = failure.diagnostics.clone();
        if let Some(object) = diagnostics.as_object_mut() {
            object.insert("provider_response".into(), raw);
        }
        entry["request"]["metadata"]["failure_code"] = Value::String(failure.code);
        entry["request"]["metadata"]["retryable"] = Value::Bool(failure.retryable);
        entry["response"]["raw"] = redaction::json(&json!({
            "failure": failure.failure,
            "diagnostics": diagnostics,
        }));
    }
    Some(redaction::json(&entry))
}

fn failure_from_runtime(failure: Option<&RuntimeFailure>) -> FailureSnapshot {
    let failure = failure.cloned().unwrap_or(RuntimeFailure {
        code: "gateway_failed".into(),
        retryable: true,
    });
    let code = failure.code.clone();
    let message = "Butler could not complete this turn.".to_owned();
    let value = json!({"code": code, "message": message, "retryable": failure.retryable});
    FailureSnapshot {
        code: code.clone(),
        message,
        retryable: failure.retryable,
        diagnostics: diagnostic_details(&value, &code, failure.retryable),
        failure: value,
    }
}

fn failure_from_loop_error(error: &AgentLoopError) -> FailureSnapshot {
    match error {
        AgentLoopError::Runtime(value) => failure_from_runtime(Some(value)),
        AgentLoopError::Propagate(value) => {
            let message = value.message().to_owned();
            let code = value.code().to_owned();
            let failure = json!({
                "code": code,
                "message": message,
                "retryable": true,
                "cause": message,
            });
            FailureSnapshot {
                code: code.clone(),
                message,
                retryable: true,
                diagnostics: diagnostic_details(&failure, &code, true),
                failure,
            }
        }
    }
}

fn redact_section(value: &Value) -> Value {
    let title = value
        .get("title")
        .and_then(Value::as_str)
        .unwrap_or_default();
    let content = value
        .get("content")
        .and_then(Value::as_str)
        .unwrap_or_default();
    let content = match serde_json::from_str::<Value>(content) {
        Ok(parsed) => serde_json::to_string(&redaction::json(&parsed)).unwrap_or_default(),
        Err(_) => redaction::string(content),
    };
    json!({
        "id": value.get("id").cloned().unwrap_or(Value::Null),
        "title": redaction::string(title),
        "region": value.get("region").cloned().unwrap_or_else(|| json!("unknown")),
        "char_count": utf16_len(&content),
        "content": content,
    })
}

fn nonempty(value: &str) -> Value {
    let value = value.trim();
    if value.is_empty() {
        Value::Null
    } else {
        Value::String(value.to_owned())
    }
}

fn response_raw(response: Option<&ResponseSnapshot>) -> Value {
    response.map_or(Value::Null, |value| value.raw.clone())
}
