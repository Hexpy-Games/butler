//! Developer-log projection with the source store schema and filters.

use std::{fs, path::Path};

use serde_json::{Value, json};

use super::now_iso;
use crate::gateway::{AppDeveloperLogsQuery, GatewayApplicationError};

fn string(value: Option<&Value>) -> Option<String> {
    value.and_then(Value::as_str).map(str::to_owned)
}

pub(super) fn read(
    root: &Path,
    query: &AppDeveloperLogsQuery,
) -> Result<Value, GatewayApplicationError> {
    let path = root.join("app/developer-logs/model-turns.jsonl");
    let contents = match fs::read_to_string(path) {
        Ok(contents) => contents,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => String::new(),
        Err(_) => return Err(GatewayApplicationError::Internal),
    };
    let kind = query
        .kind
        .as_deref()
        .filter(|kind| matches!(*kind, "model_turn" | "model_turn_error"));
    let needle = query
        .query
        .as_deref()
        .unwrap_or_default()
        .trim()
        .to_lowercase();
    let mut entries = contents
        .lines()
        .filter_map(|line| serde_json::from_str::<Value>(line).ok())
        .filter(valid_developer_log)
        .filter(|entry| kind.is_none_or(|kind| entry["kind"] == kind))
        .filter(|entry| {
            query
                .session_id
                .as_deref()
                .is_none_or(|id| entry["session_id"] == id)
        })
        .filter(|entry| {
            query
                .turn_id
                .as_deref()
                .is_none_or(|id| entry["turn_id"] == id)
        })
        .filter(|entry| needle.is_empty() || developer_log_search_text(entry).contains(&needle))
        .collect::<Vec<_>>();
    entries.sort_by(|left, right| {
        string(right.get("created_at")).cmp(&string(left.get("created_at")))
    });
    let total = entries.len();
    let limit = query.limit.unwrap_or(50).clamp(1, 100);
    let offset = query.offset.unwrap_or(0);
    let page = entries
        .into_iter()
        .skip(offset)
        .take(limit)
        .collect::<Vec<_>>();
    Ok(json!({
        "developer_mode_enabled": true, "entries": page,
        "pagination": { "limit": limit, "offset": offset, "total": total, "has_more": offset.saturating_add(limit) < total },
        "generated_at": now_iso(), "raw_text_included": true,
    }))
}

fn valid_developer_log(entry: &Value) -> bool {
    entry.get("schema").and_then(Value::as_str) == Some("butler.developer-log.v1")
        && matches!(
            entry.get("kind").and_then(Value::as_str),
            Some("model_turn" | "model_turn_error")
        )
        && entry.get("id").and_then(Value::as_str).is_some()
        && entry.get("created_at").and_then(Value::as_str).is_some()
        && entry.get("session_id").and_then(Value::as_str).is_some()
        && (entry.get("turn_id").and_then(Value::as_str).is_some()
            || entry.get("turn_id") == Some(&Value::Null))
        && entry.get("role").and_then(Value::as_str).is_some()
        && entry.get("transport").and_then(Value::as_str).is_some()
        && entry.get("privacy").is_some_and(|privacy| {
            privacy["raw_text_included"] == true
                && privacy["secrets_redacted"] == true
                && privacy["local_only"] == true
        })
        && valid_route(entry.get("route"))
        && valid_model(entry.get("model"))
        && valid_context(entry.get("context"))
        && valid_request(entry.get("request"))
        && valid_response(entry.get("response"))
}

fn valid_route(value: Option<&Value>) -> bool {
    value.is_some_and(|route| {
        ["session_id", "role", "reason", "project_id"]
            .into_iter()
            .all(|key| nullable_string(route.get(key)))
    })
}

fn valid_model(value: Option<&Value>) -> bool {
    value.is_some_and(|model| {
        model
            .get("requested_model_ref")
            .and_then(Value::as_str)
            .is_some()
            && ["provider_id", "runtime_adapter_id"]
                .into_iter()
                .all(|key| nullable_string(model.get(key)))
    })
}

fn valid_context(value: Option<&Value>) -> bool {
    value.is_some_and(|context| {
        nullable_string(context.get("live_config_hash"))
            && context
                .get("region_order")
                .and_then(Value::as_array)
                .is_some_and(|items| items.iter().all(Value::is_string))
            && context
                .get("sections")
                .and_then(Value::as_array)
                .is_some_and(|items| {
                    items.iter().all(|section| {
                        ["id", "title", "region", "content"]
                            .into_iter()
                            .all(|key| section.get(key).and_then(Value::as_str).is_some())
                            && section.get("char_count").and_then(Value::as_f64).is_some()
                    })
                })
            && context
                .get("references")
                .and_then(Value::as_array)
                .is_some()
            && context
                .get("prompt_context")
                .and_then(Value::as_str)
                .is_some()
    })
}

fn valid_request(value: Option<&Value>) -> bool {
    value.is_some_and(|request| {
        request.get("input_text").and_then(Value::as_str).is_some()
            && request.get("metadata").is_some_and(Value::is_object)
    })
}

fn valid_response(value: Option<&Value>) -> bool {
    value.is_some_and(|response| {
        response.get("text").and_then(Value::as_str).is_some() && response.get("raw").is_some()
    })
}

fn nullable_string(value: Option<&Value>) -> bool {
    value.and_then(Value::as_str).is_some() || value == Some(&Value::Null)
}

fn developer_log_search_text(entry: &Value) -> String {
    let mut parts = Vec::new();
    for pointer in [
        "/id",
        "/kind",
        "/session_id",
        "/turn_id",
        "/transport",
        "/model/requested_model_ref",
        "/model/provider_id",
        "/model/runtime_adapter_id",
        "/route/reason",
        "/route/project_id",
        "/response/text",
    ] {
        if let Some(value) = entry.pointer(pointer).and_then(Value::as_str) {
            parts.push(value.to_lowercase());
        }
    }
    parts.push(
        entry
            .pointer("/response/raw")
            .unwrap_or(&Value::Null)
            .to_string()
            .to_lowercase(),
    );
    if let Some(sections) = entry.pointer("/context/sections").and_then(Value::as_array) {
        for section in sections {
            for key in ["id", "title", "region"] {
                if let Some(value) = section.get(key).and_then(Value::as_str) {
                    parts.push(value.to_lowercase());
                }
            }
        }
    }
    parts.join("\n")
}
