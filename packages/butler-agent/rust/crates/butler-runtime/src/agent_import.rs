//! One-way import from other AI agents (Codex, Claude Code, OpenCode, Hermes):
//! the global instruction file becomes a Butler instruction and MCP server
//! definitions become Butler MCP servers. Secret values (environment values,
//! headers, tokens) are never copied; their names stay as empty slots the user
//! fills in Settings. Source files are parsed in memory and never changed.
mod formats;
mod jsonc;
mod secrets;
mod toml;
mod yaml;

use butler_platform::agent_homes::ConfigFormat;
use serde_json::{Value, json};

/// Largest instruction file imported; larger ones are reported, never cut.
pub const MAX_INSTRUCTION_BYTES: u64 = 256 * 1024;
/// Largest configuration file read (Claude Code keeps state in the same file).
pub const MAX_CONFIG_BYTES: u64 = 64 * 1024 * 1024;

/// How an MCP server is reached.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Transport {
    /// A local command.
    Stdio {
        /// Program.
        command: String,
        /// Arguments.
        args: Vec<String>,
        /// Working directory.
        cwd: Option<String>,
    },
    /// Streamable HTTP.
    Http(String),
    /// Server-sent events.
    Sse(String),
}

/// One importable MCP server, without any secret value.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct McpServer {
    /// Name in the source agent.
    pub name: String,
    /// Endpoint.
    pub transport: Transport,
    /// Environment variable names; values are never copied.
    pub env_keys: Vec<String>,
    /// Header names; values are never copied.
    pub header_keys: Vec<String>,
    /// Turned off in the source agent.
    pub disabled: bool,
    /// Has tool filters Butler cannot enforce yet.
    pub restricted: bool,
}

/// The MCP servers of one agent's configuration files.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct McpServers {
    /// Importable servers, by unique name (a later file wins).
    pub servers: Vec<McpServer>,
    /// Entries left out: unknown shape, or a secret inside the command or URL.
    pub skipped: usize,
}

/// A configuration file that could not be read as its format.
#[derive(Debug, thiserror::Error)]
#[error("configuration file is not valid")]
pub struct FormatError;

impl McpServer {
    /// Needs a secret before it can work.
    pub fn needs_secret(&self) -> bool {
        !self.env_keys.is_empty() || !self.header_keys.is_empty()
    }

    /// Ready to run as soon as it is added.
    pub fn ready(&self) -> bool {
        !self.needs_secret() && !self.disabled && !self.restricted
    }

    /// Butler registry input: secret names as empty slots; off unless ready.
    pub fn registry_input(&self, id: &str) -> Value {
        let slots = |keys: &[String]| {
            keys.iter()
                .map(|key| json!({"key": key, "source": "literal", "value": ""}))
                .collect::<Vec<_>>()
        };
        let mut input = json!({
            "id": id,
            "display_name": self.name,
            "enabled": self.ready(),
            "env": slots(&self.env_keys),
            "headers": slots(&self.header_keys),
        });
        match &self.transport {
            Transport::Stdio { command, args, cwd } => {
                input["transport"] = json!("stdio");
                input["command"] = json!(command);
                input["args"] = json!(args);
                if let Some(cwd) = cwd {
                    input["cwd"] = json!(cwd);
                }
            }
            Transport::Http(url) | Transport::Sse(url) => {
                let sse = matches!(self.transport, Transport::Sse(_));
                input["transport"] = json!(if sse { "sse" } else { "http" });
                input["url"] = json!(url);
            }
        }
        input
    }

    /// Reaches the same endpoint as a listed Butler server.
    pub fn same_target(&self, server: &Value) -> bool {
        match &self.transport {
            Transport::Stdio { command, args, .. } => {
                server["command"].as_str() == Some(command.as_str())
                    && server["args"].as_array().is_some_and(|listed| {
                        listed.len() == args.len()
                            && listed.iter().zip(args).all(|(a, b)| a.as_str() == Some(b))
                    })
            }
            Transport::Http(url) | Transport::Sse(url) => server["url"]
                .as_str()
                .is_some_and(|listed| listed.trim_end_matches('/') == url.trim_end_matches('/')),
        }
    }
}

/// MCP servers in one configuration file.
pub fn parse_config(format: ConfigFormat, bytes: &[u8]) -> Result<McpServers, FormatError> {
    let text = std::str::from_utf8(bytes).map_err(|_| FormatError)?;
    let text = text.strip_prefix('\u{feff}').unwrap_or(text);
    type Entry = fn(&str, &Value) -> Option<formats::Raw>;
    let (entries, map): (Value, Entry) = match format {
        ConfigFormat::Toml => (toml::mcp_servers(text)?, formats::codex),
        ConfigFormat::Json => (formats::claude_servers(text)?, formats::claude),
        ConfigFormat::Jsonc => (jsonc::mcp_servers(text)?, formats::opencode),
        ConfigFormat::Yaml => (yaml::mcp_servers(text)?, formats::hermes),
    };
    let mut parsed = McpServers::default();
    for (name, entry) in entries.as_object().into_iter().flatten() {
        match map(name, entry).and_then(formats::Raw::finish) {
            Some(server) => parsed.servers.push(server),
            None => parsed.skipped += 1,
        }
    }
    Ok(parsed)
}

impl McpServers {
    /// Adds a later file; a server of the same name replaces the earlier one.
    pub fn merge(&mut self, later: McpServers) {
        for server in later.servers {
            self.servers.retain(|known| known.name != server.name);
            self.servers.push(server);
        }
        self.skipped += later.skipped;
    }
}

/// The heading that marks an imported instruction and names its source.
const HEADING: &str = "# From ";

/// Instruction text for Butler: a source heading, then the file unchanged.
/// `None` when the file has no text.
pub fn instruction_text(agent: &str, label: &str, body: &str) -> Option<String> {
    let body = body.replace("\r\n", "\n");
    let body = body.trim();
    (!body.is_empty()).then(|| format!("{HEADING}{agent} ({label})\n\n{body}"))
}

/// The imported body of an instruction, for duplicate checks across sources.
pub fn instruction_body(text: &str) -> &str {
    let text = text.trim();
    match text.split_once("\n\n") {
        Some((heading, body)) if heading.starts_with(HEADING) && !heading.contains('\n') => {
            body.trim()
        }
        _ => text,
    }
}
