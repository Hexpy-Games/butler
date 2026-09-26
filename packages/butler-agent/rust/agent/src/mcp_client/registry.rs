use std::{collections::HashMap, fs, path::Path};

use serde_json::Value;

#[derive(Clone, Copy, PartialEq, Eq)]
pub(super) enum McpTransportKind {
    Stdio,
    Http,
    Sse,
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum SecretSource {
    Literal,
    Environment,
    File,
}

#[derive(Clone)]
struct SecretValue {
    source: SecretSource,
    value: String,
}

#[derive(Clone)]
struct KeyValueSecret {
    key: String,
    secret: SecretValue,
}

#[derive(Clone)]
pub(super) struct McpServerConfig {
    pub id: String,
    pub display_name: String,
    pub enabled: bool,
    pub transport: McpTransportKind,
    pub command: Option<String>,
    pub args: Vec<String>,
    pub cwd: Option<String>,
    pub url: Option<String>,
    env: Vec<KeyValueSecret>,
    headers: Vec<KeyValueSecret>,
    created_at: String,
    updated_at: String,
}

pub(super) struct ResolvedServerSecrets {
    pub env: Vec<(String, String)>,
    pub headers: Vec<(String, String)>,
    pub redact: Vec<String>,
}

pub(super) fn read_registry(data_root: &Path) -> Result<Vec<McpServerConfig>, String> {
    let value = read_registry_value(data_root)?;
    let Some(servers) = value.get("servers").and_then(Value::as_array) else {
        return Ok(Vec::new());
    };

    servers
        .iter()
        .filter_map(Value::as_object)
        .map(normalize_server)
        .collect()
}

pub(super) fn read_registry_value(data_root: &Path) -> Result<Value, String> {
    crate::configuration::read_json_object(&registry_path(data_root))
}

pub(super) fn registry_path(data_root: &Path) -> std::path::PathBuf {
    data_root.join("config").join("mcp-servers.json")
}

pub(super) fn normalize_server_config(value: &Value) -> Result<McpServerConfig, String> {
    value
        .as_object()
        .ok_or_else(|| "MCP server configuration is invalid.".to_owned())
        .and_then(normalize_server)
}

pub(super) fn now_iso() -> String {
    use std::time::{SystemTime, UNIX_EPOCH};
    let elapsed = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default();
    chrono::DateTime::<chrono::Utc>::from_timestamp(
        i64::try_from(elapsed.as_secs()).unwrap_or(i64::MAX),
        elapsed.subsec_nanos(),
    )
    .map(|date| date.to_rfc3339_opts(chrono::SecondsFormat::Millis, true))
    .unwrap_or_else(|| "1970-01-01T00:00:00.000Z".to_owned())
}

pub(super) fn server_to_value(server: &McpServerConfig) -> Value {
    let secret_values = |values: &[KeyValueSecret]| {
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
                    "value": item.secret.value,
                })
            })
            .collect::<Vec<_>>()
    };
    let mut value = serde_json::json!({
        "id": server.id,
        "display_name": server.display_name,
        "enabled": server.enabled,
        "transport": match server.transport {
            McpTransportKind::Stdio => "stdio",
            McpTransportKind::Http => "http",
            McpTransportKind::Sse => "sse",
        },
        "args": server.args,
        "env": secret_values(&server.env),
        "headers": secret_values(&server.headers),
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

/// Stable server facts used to bind a discovered tool capability without
/// including secret values in the digest input or exposing them to callers.
pub(super) fn server_capability_projection(server: &McpServerConfig) -> Value {
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

pub(super) fn redact_server(server: &McpServerConfig) -> Value {
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
                    "has_value": !item.secret.value.is_empty(),
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

pub(super) fn normalize_server_id(value: &str) -> String {
    let mut normalized = String::new();
    let mut in_separator = false;
    for ch in value.trim().to_lowercase().chars() {
        if ch.is_ascii_alphanumeric() || matches!(ch, '.' | '_' | '-') {
            normalized.push(ch);
            in_separator = false;
        } else if !in_separator {
            normalized.push('-');
            in_separator = true;
        }
    }
    normalized.trim_matches('-').chars().take(80).collect()
}

pub(super) fn resolve_secrets(
    server: &McpServerConfig,
    environment: &HashMap<String, String>,
) -> Result<ResolvedServerSecrets, String> {
    let mut result = ResolvedServerSecrets {
        env: Vec::new(),
        headers: Vec::new(),
        redact: Vec::new(),
    };
    for (source, values) in [(0, &server.env), (1, &server.headers)] {
        for item in values {
            let value = resolve_secret(&item.secret, environment)?;
            if !value.is_empty() {
                result.redact.push(value.clone());
                if source == 0 {
                    result.env.push((item.key.clone(), value));
                } else {
                    result.headers.push((item.key.clone(), value));
                }
            }
        }
    }
    result
        .redact
        .sort_by_key(|value| std::cmp::Reverse(value.len()));
    result.redact.dedup();
    Ok(result)
}

pub(super) fn redact_text(value: &str, secrets: &[String]) -> String {
    secrets.iter().fold(value.to_owned(), |text, secret| {
        if secret.is_empty() {
            text
        } else {
            text.replace(secret, "[redacted]")
        }
    })
}

fn normalize_server(value: &serde_json::Map<String, Value>) -> Result<McpServerConfig, String> {
    let id = normalize_server_id(
        string_field(value, "id")
            .or_else(|| string_field(value, "display_name"))
            .unwrap_or(""),
    );
    if id.is_empty() {
        return Err("MCP server id is required.".into());
    }
    let transport = match string_field(value, "transport") {
        Some("http") => McpTransportKind::Http,
        Some("sse") => McpTransportKind::Sse,
        _ => McpTransportKind::Stdio,
    };
    let command = clean_string(value.get("command"));
    let url = clean_string(value.get("url"));
    match transport {
        McpTransportKind::Stdio if command.is_none() => {
            return Err("stdio MCP servers require command.".into());
        }
        McpTransportKind::Http if url.is_none() => {
            return Err("http MCP servers require url.".into());
        }
        McpTransportKind::Sse if url.is_none() => {
            return Err("sse MCP servers require url.".into());
        }
        _ => {}
    }
    let display_name = clean_string(value.get("display_name")).unwrap_or_else(|| id.clone());
    let now = now_iso();
    Ok(McpServerConfig {
        id,
        display_name,
        enabled: value.get("enabled") != Some(&Value::Bool(false)),
        transport,
        command,
        args: value
            .get("args")
            .and_then(Value::as_array)
            .into_iter()
            .flatten()
            .filter_map(Value::as_str)
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .map(str::to_owned)
            .collect(),
        cwd: clean_string(value.get("cwd")),
        url,
        env: normalize_secrets(value.get("env")),
        headers: normalize_secrets(value.get("headers")),
        created_at: string_field(value, "created_at").unwrap_or(&now).to_owned(),
        updated_at: string_field(value, "updated_at").unwrap_or(&now).to_owned(),
    })
}

fn normalize_secrets(value: Option<&Value>) -> Vec<KeyValueSecret> {
    value
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(Value::as_object)
        .filter_map(|item| {
            let key = item
                .get("key")
                .and_then(Value::as_str)
                .unwrap_or("")
                .trim()
                .chars()
                .map(|ch| {
                    if ch.is_ascii_alphanumeric() || matches!(ch, '_' | '.' | '-') {
                        ch
                    } else {
                        '_'
                    }
                })
                .collect::<String>();
            let value = item.get("value").and_then(Value::as_str).unwrap_or("");
            if key.is_empty() || value.is_empty() {
                return None;
            }
            let source = match item.get("source").and_then(Value::as_str) {
                Some("env") => SecretSource::Environment,
                Some("file") => SecretSource::File,
                _ => SecretSource::Literal,
            };
            Some(KeyValueSecret {
                key,
                secret: SecretValue {
                    source,
                    value: value.to_owned(),
                },
            })
        })
        .collect()
}

fn resolve_secret(
    secret: &SecretValue,
    environment: &HashMap<String, String>,
) -> Result<String, String> {
    match secret.source {
        SecretSource::Literal => Ok(secret.value.clone()),
        SecretSource::Environment => {
            Ok(environment.get(&secret.value).cloned().unwrap_or_default())
        }
        SecretSource::File => match fs::read_to_string(Path::new(&secret.value)) {
            Ok(value) => Ok(value.trim_end().to_owned()),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(String::new()),
            Err(_) => Err("MCP secret file could not be read.".into()),
        },
    }
}

fn clean_string(value: Option<&Value>) -> Option<String> {
    value
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_owned)
}

fn string_field<'a>(value: &'a serde_json::Map<String, Value>, key: &str) -> Option<&'a str> {
    value
        .get(key)
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn missing_registry_is_read_only_and_secret_sources_are_resolved_per_call() {
        let root =
            std::env::temp_dir().join(format!("butler-mcp-registry-{}", uuid::Uuid::new_v4()));
        assert!(read_registry(&root).unwrap().is_empty());
        assert!(!root.exists());

        let secret_path =
            std::env::temp_dir().join(format!("butler-mcp-secret-{}", uuid::Uuid::new_v4()));
        fs::write(&secret_path, "file-secret\n").unwrap();
        let value = serde_json::json!({
            "id":"local", "transport":"stdio", "command":"fixture",
            "env":[
                {"key":"LITERAL","source":"literal","value":"literal-secret"},
                {"key":"FROM_ENV","source":"env","value":"MCP_TEST_SECRET"},
                {"key":"FROM_FILE","source":"file","value":secret_path.to_string_lossy()},
            ]
        });
        let config = normalize_server(value.as_object().unwrap()).unwrap();
        let resolved = resolve_secrets(
            &config,
            &HashMap::from([("MCP_TEST_SECRET".into(), "environment-secret".into())]),
        )
        .unwrap();
        assert_eq!(
            resolved.env,
            vec![
                ("LITERAL".into(), "literal-secret".into()),
                ("FROM_ENV".into(), "environment-secret".into()),
                ("FROM_FILE".into(), "file-secret".into()),
            ]
        );
        assert_eq!(
            redact_text(
                "literal-secret environment-secret file-secret",
                &resolved.redact
            ),
            "[redacted] [redacted] [redacted]"
        );
        fs::remove_file(secret_path).unwrap();
        assert!(!root.exists());
    }
}
