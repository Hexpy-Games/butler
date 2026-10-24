//! Independent request contract oracle. Never calls the production encoder.
use axum::{
    body::Body,
    http::{HeaderMap, Method, Request, StatusCode},
    middleware::Next,
    response::{IntoResponse, Response},
};
use serde_json::{Value, json};
use std::{
    collections::HashMap,
    sync::{LazyLock, Mutex},
};
#[derive(Debug)]
pub struct Violation(pub String);
impl std::fmt::Display for Violation {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.0)
    }
}
impl std::error::Error for Violation {}
static VIOLATIONS: LazyLock<Mutex<HashMap<String, Vec<String>>>> =
    LazyLock::new(|| Mutex::new(HashMap::new()));
pub struct Scope(Option<String>);
impl Scope {
    pub fn new(environment: &[(String, String)]) -> Self {
        Self(
            environment
                .iter()
                .rev()
                .find(|(k, _)| k == "BUTLER_CHATGPT_API_BASE_URL")
                .and_then(|(_, v)| url::Url::parse(v).ok())
                .and_then(|url| {
                    Some(format!(
                        "{}:{}",
                        url.host_str()?,
                        url.port_or_known_default()?
                    ))
                }),
        )
    }
    pub fn finish(&self) -> Result<(), super::HarnessError> {
        let errors = self
            .0
            .as_ref()
            .and_then(|host| {
                VIOLATIONS
                    .lock()
                    .unwrap_or_else(std::sync::PoisonError::into_inner)
                    .remove(host)
            })
            .unwrap_or_default();
        if errors.is_empty() {
            Ok(())
        } else {
            Err(super::harness_error(format!(
                "ChatGPT wire: {}",
                errors.join(", ")
            )))
        }
    }
}

/// P3 updates this expected shape independently of the production encoder.
fn expected_namespace(tool: &Value) -> Option<&[Value]> {
    let children = tool["tools"].as_array()?;
    (tool["type"] == "namespace"
        && tool["name"] == "butler"
        && tool["description"] == "Butler tools"
        && !children.is_empty()
        && children.iter().all(|item| item["type"] == "function")
        && tool.as_object().is_some_and(|o| o.len() == 4))
    .then_some(children.as_slice())
}
/// Preserve every tool, flattening only the independently checked wrapper.
pub fn tools(body: &Value) -> impl Iterator<Item = &Value> {
    body["tools"]
        .as_array()
        .into_iter()
        .flatten()
        .flat_map(|tool| {
            expected_namespace(tool)
                .unwrap_or_else(|| std::slice::from_ref(tool))
                .iter()
        })
}
/// Inspect the complete offered function definitions.
pub fn functions(body: &Value) -> impl Iterator<Item = &Value> {
    tools(body).filter(|tool| tool["type"] == "function")
}
/// Derive param paths from the actual request, without a second namespace schema.
pub fn function_paths(body: &Value) -> Vec<(String, &Value)> {
    let mut found = Vec::new();
    if let Some(value) = body.get("tools") {
        collect_functions(value, "tools", &mut found);
    }
    found
}
fn collect_functions<'a>(value: &'a Value, path: &str, found: &mut Vec<(String, &'a Value)>) {
    match value {
        Value::Object(_) if value["type"] == "function" => found.push((path.into(), value)),
        Value::Object(object) => {
            for (key, child) in object {
                collect_functions(child, &format!("{path}.{key}"), found);
            }
        }
        Value::Array(array) => {
            for (index, child) in array.iter().enumerate() {
                collect_functions(child, &format!("{path}[{index}]"), found);
            }
        }
        _ => {}
    }
}
pub fn assert_request(headers: &HeaderMap, body: &Value) -> Result<(), Violation> {
    let check = |valid: bool, name: &str| {
        if valid {
            Ok(())
        } else {
            Err(Violation(name.into()))
        }
    };
    check(body["store"] == false, "store_false")?;
    check(body["stream"] == true, "stream_true")?;
    for field in [
        "background",
        "conversation",
        "max_output_tokens",
        "max_tool_calls",
        "metadata",
        "moderation",
        "multi_agent",
        "prompt",
        "prompt_cache_retention",
        "safety_identifier",
        "temperature",
        "top_logprobs",
        "top_p",
        "truncation",
        "user",
        "previous_response_id",
        "prompt_cache_options",
    ] {
        check(
            body.get(field).is_none(),
            &format!("forbidden_field:{field}"),
        )?;
    }
    check(
        body["input"]
            .as_array()
            .is_none_or(|items| items.iter().all(|item| item["role"] != "system")),
        "system_role",
    )?;
    if let Some(tools) = body["tools"].as_array() {
        for tool in tools {
            check(tool["type"] != "function", "top_level_function")?;
            if tool["type"] == "namespace" {
                check(expected_namespace(tool).is_some(), "namespace_shape")?;
            }
        }
    }
    check(
        headers
            .get("authorization")
            .and_then(|h| h.to_str().ok())
            .is_some_and(|h| h.starts_with("Bearer ")),
        "bearer_authorization",
    )?;
    for name in [
        "chatgpt-account-id",
        "originator",
        "openai-beta",
        "session-id",
    ] {
        check(
            !headers.contains_key(name),
            &format!("forbidden_header:{name}"),
        )?;
    }
    Ok(())
}
pub fn assert_http(
    method: &Method,
    path: &str,
    headers: &HeaderMap,
    body: &Value,
) -> Result<(), Violation> {
    if method != Method::POST {
        return Err(Violation("method_post".into()));
    }
    if path != "/v1/responses" {
        return Err(Violation("responses_path".into()));
    }
    assert_request(headers, body)
}
/// One common middleware call on every serving stub router.
pub async fn validate(request: Request<Body>, next: Next) -> Response {
    let (parts, body) = request.into_parts();
    let bytes = axum::body::to_bytes(body, 64 * 1024 * 1024)
        .await
        .unwrap_or_default();
    let body = serde_json::from_slice(&bytes).unwrap_or(Value::Null);
    if let Err(violation) = assert_http(&parts.method, parts.uri.path(), &parts.headers, &body) {
        let host = parts
            .headers
            .get("host")
            .and_then(|h| h.to_str().ok())
            .unwrap_or("")
            .to_owned();
        VIOLATIONS
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .entry(host)
            .or_default()
            .push(violation.to_string());
        return (
            StatusCode::NOT_IMPLEMENTED,
            json!({"violation":violation.to_string()}).to_string(),
        )
            .into_response();
    }
    next.run(Request::from_parts(parts, Body::from(bytes)))
        .await
}
