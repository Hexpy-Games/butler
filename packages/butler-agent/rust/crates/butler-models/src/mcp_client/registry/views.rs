use super::{KeyValueSecret, McpServerConfig, McpTransportKind, SecretSource};
use serde_json::Value;

/// Stable server facts used to bind a discovered tool capability without
/// including secret values in the digest input or exposing them to callers.
pub(in crate::mcp_client) fn server_capability_projection(server: &McpServerConfig) -> Value {
    let secret_sources = |values: &[KeyValueSecret]| {
        values
            .iter()
            .map(|item| {
                serde_json::json!({
                    "key": item.key,
                    "source": match item.secret.source {
                        SecretSource::Literal => "literal",
                        SecretSource::Environment => "env",
                        SecretSource::File => "file",
                    },
                })
            })
            .collect::<Vec<_>>()
    };
    serde_json::json!({
        "id": server.id,
        "transport": server.transport.as_str(),
        "command": server.command,
        "args": server.args,
        "cwd": server.cwd,
        "url": server.url,
        "env": secret_sources(&server.env),
        "headers": secret_sources(&server.headers),
        "updated_at": server.updated_at,
    })
}

pub(in crate::mcp_client) fn redact_server(server: &McpServerConfig) -> Value {
    let redact = |values: &[KeyValueSecret]| {
        values
            .iter()
            .map(|item| {
                let mut value = serde_json::json!({
                    "key": item.key,
                    "source": match item.secret.source {
                        SecretSource::Literal => "literal",
                        SecretSource::Environment => "env",
                        SecretSource::File => "file",
                    },
                    "redacted": item.secret.source == SecretSource::Literal,
                    "has_value": !item.secret.value.is_empty() || item.secret.storage.is_some(),
                });
                if item.secret.source != SecretSource::Literal {
                    value["value"] = Value::String(item.secret.value.clone());
                }
                value
            })
            .collect::<Vec<_>>()
    };
    let mut value = serde_json::json!({
        "id": server.id,
        "display_name": server.display_name,
        "enabled": server.enabled,
        "tool_filter_review_required": server.tool_filter_review_required,
        "transport": match server.transport {
            McpTransportKind::Stdio => "stdio",
            McpTransportKind::Http => "http",
            McpTransportKind::Sse => "sse",
        },
        "args": server.args,
        "env": redact(&server.env),
        "headers": redact(&server.headers),
        "created_at": server.created_at,
        "updated_at": server.updated_at,
    });
    if let Some(command) = &server.command {
        value["command"] = Value::String(command.clone());
    }
    if let Some(cwd) = &server.cwd {
        value["cwd"] = Value::String(cwd.clone());
    }
    if let Some(url) = &server.url {
        value["url"] = Value::String(url.clone());
    }
    value
}
