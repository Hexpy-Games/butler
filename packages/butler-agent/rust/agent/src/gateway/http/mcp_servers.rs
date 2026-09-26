use std::sync::Arc;

use axum::{
    body::{Body, Bytes},
    http::{Method, Request, StatusCode, Uri},
    response::Response,
};
use serde_json::Value;

use crate::gateway::protocol::{APP_PROTOCOL_VERSION, ApiEnvelope};

use super::{HttpError, HttpState, json as json_response, read_body_with_limit};

pub(super) async fn route(
    state: Arc<HttpState>,
    request: Request<Body>,
    uri: &Uri,
) -> Result<Response, HttpError> {
    let method = request.method().clone();
    match (method, uri.path()) {
        (Method::GET, "/mcp-servers") => {
            api(StatusCode::OK, state.application.list_mcp_servers().await?)
        }
        (Method::GET, "/mcp-capabilities") => api(
            StatusCode::OK,
            state
                .application
                .list_mcp_capabilities(state.shutdown.clone())
                .await?,
        ),
        (Method::POST, "/mcp-servers") => {
            let input = parse_upsert(request).await?;
            api(
                StatusCode::CREATED,
                state.application.create_mcp_server(input).await?,
            )
        }
        (Method::PATCH, path) if server_id(path).is_some() => {
            let input = parse_upsert(request).await?;
            let id = decode_server_id(path)?;
            api(
                StatusCode::OK,
                state.application.update_mcp_server(id, input).await?,
            )
        }
        (Method::DELETE, path) if server_id(path).is_some() => {
            let id = decode_server_id(path)?;
            api(
                StatusCode::OK,
                state.application.delete_mcp_server(id).await?,
            )
        }
        (Method::POST, path) if probe_id(path).is_some() => {
            let id = decode_probe_id(path)?;
            api(
                StatusCode::OK,
                state
                    .application
                    .probe_mcp_server(id, state.shutdown.clone())
                    .await?,
            )
        }
        _ => Err(HttpError::public(404, "not_found", "Route not found.")),
    }
}

fn api(status: StatusCode, data: Value) -> Result<Response, HttpError> {
    json_response(
        status,
        ApiEnvelope {
            protocol_version: APP_PROTOCOL_VERSION,
            data,
        },
    )
}

async fn parse_upsert(request: Request<Body>) -> Result<Value, HttpError> {
    let bytes: Bytes =
        read_body_with_limit(request.into_body(), super::MAX_REQUEST_BODY_SIZE).await?;
    let value: Value = serde_json::from_slice(&bytes).map_err(|_| HttpError::invalid_json())?;
    if !is_upsert_request(&value) {
        return Err(HttpError::public(
            400,
            "invalid_mcp_server_request",
            "MCP server request contains unsupported fields.",
        ));
    }
    Ok(value)
}

fn is_upsert_request(value: &Value) -> bool {
    let Some(input) = value.as_object() else {
        return false;
    };
    if !input.keys().all(|key| {
        matches!(
            key.as_str(),
            "id" | "display_name"
                | "enabled"
                | "transport"
                | "command"
                | "args"
                | "cwd"
                | "url"
                | "env"
                | "headers"
        )
    }) {
        return false;
    }
    for (key, field) in input {
        let valid = match key.as_str() {
            "id" | "display_name" | "command" | "cwd" | "url" => field.is_string(),
            "enabled" => field.is_boolean(),
            "transport" => matches!(field.as_str(), Some("stdio" | "http" | "sse")),
            "args" => field
                .as_array()
                .is_some_and(|values| values.iter().all(Value::is_string)),
            "env" | "headers" => valid_secrets(field),
            _ => false,
        };
        if !valid {
            return false;
        }
    }
    true
}

fn valid_secrets(value: &Value) -> bool {
    value.as_array().is_some_and(|values| {
        values.iter().all(|item| {
            item.as_object().is_some_and(|secret| {
                secret.get("key").is_some_and(Value::is_string)
                    && secret.get("value").is_some_and(Value::is_string)
                    && matches!(
                        secret.get("source").and_then(Value::as_str),
                        Some("literal" | "env" | "file")
                    )
            })
        })
    })
}

fn server_id(path: &str) -> Option<&str> {
    let id = path.strip_prefix("/mcp-servers/")?;
    (!id.is_empty() && !id.contains('/') && id != "capabilities").then_some(id)
}

fn probe_id(path: &str) -> Option<&str> {
    let id = path.strip_prefix("/mcp-servers/")?.strip_suffix("/probe")?;
    (!id.is_empty() && !id.contains('/')).then_some(id)
}

fn decode_server_id(path: &str) -> Result<String, HttpError> {
    let raw =
        server_id(path).ok_or_else(|| HttpError::public(404, "not_found", "Route not found."))?;
    super::subsessions::decode_component(raw)
}

fn decode_probe_id(path: &str) -> Result<String, HttpError> {
    let raw =
        probe_id(path).ok_or_else(|| HttpError::public(404, "not_found", "Route not found."))?;
    super::subsessions::decode_component(raw)
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::is_upsert_request;

    #[test]
    fn upsert_guard_rejects_unknown_top_level_but_accepts_nested_secret_metadata() {
        assert!(is_upsert_request(&json!({
            "transport":"http",
            "url":"http://127.0.0.1/mcp",
            "headers":[{"key":"Authorization","source":"env","value":"TOKEN","metadata":true}]
        })));
        assert!(!is_upsert_request(&json!({"id":"safe","unexpected":true})));
        assert!(!is_upsert_request(&json!({
            "env":[{"key":"TOKEN","source":"local","value":"x"}]
        })));
    }
}
