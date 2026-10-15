//! Each agent's MCP entry shape, mapped onto one neutral form.
use super::{FormatError, McpServer, Transport, secrets};
use serde_json::{Map, Value};

/// An MCP entry before validation; secret values are already dropped.
#[derive(Default)]
pub(super) struct Raw {
    name: String,
    command: Option<String>,
    args: Vec<String>,
    cwd: Option<String>,
    url: Option<String>,
    sse: bool,
    env_keys: Vec<String>,
    header_keys: Vec<String>,
    disabled: bool,
    restricted: bool,
}

impl Raw {
    /// A usable server, or `None` for an unknown shape or a secret in the
    /// command line or URL (those need setting up by hand).
    pub(super) fn finish(self) -> Option<McpServer> {
        let transport = match (self.command, self.url) {
            (Some(command), None) => {
                if secrets::in_arguments(&self.args) {
                    return None;
                }
                Transport::Stdio {
                    command,
                    args: self.args,
                    cwd: self.cwd,
                }
            }
            (None, Some(url)) if secrets::url_is_clean(&url) => {
                if self.sse {
                    Transport::Sse(url)
                } else {
                    Transport::Http(url)
                }
            }
            _ => return None,
        };
        Some(McpServer {
            name: self.name,
            transport,
            env_keys: unique(self.env_keys),
            header_keys: unique(self.header_keys),
            disabled: self.disabled,
            restricted: self.restricted,
        })
    }
}

fn unique(mut keys: Vec<String>) -> Vec<String> {
    let mut seen = std::collections::HashSet::new();
    keys.retain(|key| !key.is_empty() && seen.insert(key.clone()));
    keys
}

fn text(entry: &Value, key: &str) -> Option<String> {
    entry[key]
        .as_str()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_owned)
}

fn strings(value: &Value) -> Vec<String> {
    value
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(|item| match item {
            Value::String(text) => Some(text.clone()),
            Value::Number(number) => Some(number.to_string()),
            Value::Bool(flag) => Some(flag.to_string()),
            _ => None,
        })
        .collect()
}

/// Names of a key/value table; the values are secrets and stay behind.
fn names(value: &Value) -> Vec<String> {
    value
        .as_object()
        .map(|table| table.keys().cloned().collect())
        .unwrap_or_default()
}

fn has_items(value: &Value) -> bool {
    value.as_array().is_some_and(|items| !items.is_empty())
}

fn base(name: &str, entry: &Value) -> Option<Raw> {
    entry.is_object().then(|| Raw {
        name: name.trim().to_owned(),
        command: text(entry, "command"),
        args: strings(&entry["args"]),
        cwd: text(entry, "cwd"),
        url: text(entry, "url"),
        env_keys: names(&entry["env"]),
        header_keys: names(&entry["headers"]),
        ..Raw::default()
    })
}

/// Codex `[mcp_servers.<name>]`.
pub(super) fn codex(name: &str, entry: &Value) -> Option<Raw> {
    let mut raw = base(name, entry)?;
    raw.env_keys.extend(strings(&entry["env_vars"]));
    raw.header_keys.extend(names(&entry["http_headers"]));
    raw.header_keys.extend(names(&entry["env_http_headers"]));
    if entry["bearer_token_env_var"].is_string() {
        raw.header_keys.push("Authorization".into());
    }
    raw.disabled = entry["enabled"] == Value::Bool(false);
    raw.restricted = entry["enabled_tools"].is_array() || has_items(&entry["disabled_tools"]);
    Some(raw)
}

/// Claude Code user-scope `mcpServers` in its home-folder JSON file.
pub(super) fn claude(name: &str, entry: &Value) -> Option<Raw> {
    let mut raw = base(name, entry)?;
    raw.sse = entry["type"] == "sse";
    raw.disabled = entry["disabled"] == Value::Bool(true);
    Some(raw)
}

/// Only the `mcpServers` member of Claude Code's mixed state file is kept:
/// account and project fields are parsed past and dropped.
pub(super) fn claude_servers(text: &str) -> Result<Value, FormatError> {
    #[derive(serde::Deserialize)]
    struct Claude {
        #[serde(rename = "mcpServers", default)]
        mcp_servers: Map<String, Value>,
        #[serde(rename = "disabledMcpServers", default)]
        disabled_servers: Vec<String>,
    }
    serde_json::from_str::<Claude>(text)
        .map(|mut claude| {
            for name in claude.disabled_servers {
                if let Some(Value::Object(entry)) = claude.mcp_servers.get_mut(&name) {
                    entry.insert("disabled".into(), Value::Bool(true));
                }
            }
            Value::Object(claude.mcp_servers)
        })
        .map_err(|_| FormatError)
}

/// OpenCode `mcp`: a local command array or a remote URL.
pub(super) fn opencode(name: &str, entry: &Value) -> Option<Raw> {
    let mut raw = base(name, entry)?;
    raw.disabled = entry["enabled"] == Value::Bool(false);
    match entry["type"].as_str() {
        Some("local") => {
            let mut command = strings(&entry["command"]).into_iter();
            raw.command = command.next().filter(|program| !program.trim().is_empty());
            raw.args = command.collect();
            raw.env_keys = names(&entry["environment"]);
        }
        Some("remote") => raw.command = None,
        _ => return None,
    }
    Some(raw)
}

/// Hermes `mcp_servers` in `config.yaml`.
pub(super) fn hermes(name: &str, entry: &Value) -> Option<Raw> {
    let mut raw = base(name, entry)?;
    raw.disabled = entry["enabled"] == Value::Bool(false);
    let tools = &entry["tools"];
    raw.restricted = tools["include"].is_array() || has_items(&tools["exclude"]);
    Some(raw)
}
